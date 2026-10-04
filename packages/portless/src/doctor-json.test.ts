import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const PROXY_PORT = 43123;
const ALIVE_PID = 101;
const STALE_PID = 202;

type Finding = {
  code: string;
  status: "ok" | "info" | "warn" | "fail";
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
};

type Report = {
  schemaVersion: number;
  command: string;
  metadata: {
    version: string;
    nodeVersion: string;
    platform: string;
    arch: string;
    stateDir: string;
    proxy: {
      url: string;
      port: number;
      tls: boolean;
      running: boolean;
      portListening: boolean;
      customCertificate: boolean;
    };
    tlds: string[];
    lan: { enabled: boolean; ip: string | null };
  };
  findings: Finding[];
  summary: { failures: number; warnings: number };
};

describe("doctor JSON output", () => {
  let root: string;
  let stateDir: string;
  let preloadPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "portless-doctor-json-"));
    stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir);
    preloadPath = path.join(root, "preload.cjs");
    // Keep subprocess-level coverage deterministic without probing real services,
    // resolving public hostnames, or relying on host process-inspection tools.
    fs.writeFileSync(
      preloadPath,
      `
const { EventEmitter } = require("node:events");
const { syncBuiltinESMExports } = require("node:module");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const dns = require("node:dns");
const childProcess = require("node:child_process");
const mode = process.env.PORTLESS_TEST_PROXY_MODE || "stopped";
http.request = https.request = (_options, callback) => {
  const request = new EventEmitter();
  request.destroy = () => {};
  request.end = () => queueMicrotask(() => {
    if (mode === "running") callback({ headers: { "x-portless": "1" }, resume() {} });
    else request.emit("error", new Error("No portless proxy"));
  });
  return request;
};
net.connect = (options) => {
  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.setTimeout = () => socket;
  queueMicrotask(() => {
    if (mode !== "stopped" && options.port === ${PROXY_PORT}) socket.emit("connect");
    else socket.emit("error", new Error("No listener"));
  });
  return socket;
};
dns.lookup = (_hostname, callback) => queueMicrotask(() => callback(null, "127.0.0.1", 4));
process.kill = (pid, signal) => {
  if (signal !== 0) throw new Error("doctor must not signal processes");
  if (pid === ${ALIVE_PID}) return true;
  const error = new Error("No process");
  error.code = "ESRCH";
  throw error;
};
childProcess.execSync = () => process.platform === "win32"
  ? "TCP  127.0.0.1:${PROXY_PORT}  0.0.0.0:0  LISTENING  ${ALIVE_PID}"
  : "${ALIVE_PID}\\n";
childProcess.spawnSync = () => ({ status: 0, stdout: "", stderr: "" });
syncBuiltinESMExports();
`
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(
    args = ["doctor", "--json"],
    mode: "stopped" | "running" | "conflict" = "stopped",
    envOverrides: Record<string, string> = {}
  ) {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.startsWith("PORTLESS") || name === "PNPM_SCRIPT_SRC_DIR" || name === "NO_COLOR") {
        delete env[name];
      }
    }
    if (env.npm_command === "exec") delete env.npm_command;
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 10_000,
      env: {
        ...env,
        NODE_OPTIONS: `--require=${JSON.stringify(preloadPath)}`,
        FORCE_COLOR: "1",
        PORTLESS_STATE_DIR: stateDir,
        PORTLESS_PORT: String(PROXY_PORT),
        PORTLESS_HTTPS: "0",
        PORTLESS_LAN: "0",
        PORTLESS_TEST_PROXY_MODE: mode,
        ...envOverrides,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return result;
  }

  function parseReport(result: ReturnType<typeof run>): Report {
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("\u001b[");
    const report = JSON.parse(result.stdout) as Report;
    expect(Object.keys(report).sort()).toEqual([
      "command",
      "findings",
      "metadata",
      "schemaVersion",
      "summary",
    ]);
    expect(report.schemaVersion).toBe(1);
    expect(report.command).toBe("doctor");
    expect(report.summary).toEqual({
      failures: report.findings.filter((finding) => finding.status === "fail").length,
      warnings: report.findings.filter((finding) => finding.status === "warn").length,
    });
    for (const finding of report.findings) {
      expect(finding.code).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(finding.message).not.toBe("");
    }
    return report;
  }

  it("prints one color-free JSON document with metadata and warning-only exit code 0", () => {
    const result = run();
    const report = parseReport(result);
    expect(result.status).toBe(0);
    expect(report.metadata).toEqual({
      version: expect.stringMatching(/^\d+\./),
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      stateDir,
      proxy: {
        url: `http://127.0.0.1:${PROXY_PORT}`,
        port: PROXY_PORT,
        tls: false,
        running: false,
        portListening: false,
        customCertificate: false,
      },
      tlds: ["localhost"],
      lan: { enabled: false, ip: null },
    });
    expect(report.findings).toContainEqual({
      code: "proxy.not_running",
      status: "warn",
      message: `Proxy is not running on port ${PROXY_PORT}.`,
      hint: "Run: portless proxy start --no-tls",
      details: { port: PROXY_PORT },
    });
    expect(report.summary).toEqual({ failures: 0, warnings: 1 });
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("reports a healthy proxy and stable structured process details", () => {
    fs.writeFileSync(path.join(stateDir, "proxy.port"), String(PROXY_PORT));
    fs.writeFileSync(path.join(stateDir, "proxy.pid"), String(ALIVE_PID));
    const result = run(undefined, "running");
    const report = parseReport(result);
    expect(result.status).toBe(0);
    expect(report.metadata.proxy).toMatchObject({ running: true, portListening: true });
    expect(report.findings).toContainEqual({
      code: "proxy.pid_responding",
      status: "ok",
      message: `Proxy PID file points to the responding proxy process: ${ALIVE_PID}`,
      details: { pid: ALIVE_PID },
    });
    expect(report.summary).toEqual({ failures: 0, warnings: 0 });
  });

  it("reports proxy port conflicts as structured failures and exits 1", () => {
    const result = run(undefined, "conflict");
    const report = parseReport(result);
    expect(result.status).toBe(1);
    expect(report.metadata.proxy).toMatchObject({ running: false, portListening: true });
    expect(report.findings).toContainEqual({
      code: "proxy.port_conflict",
      status: "fail",
      message: `Port ${PROXY_PORT} is in use, but it is not a portless proxy.`,
      hint: `Process on port: PID ${ALIVE_PID}`,
      details: { port: PROXY_PORT, pid: ALIVE_PID },
    });
    expect(report.summary.failures).toBe(1);
  });

  it("captures corrupt-state warnings in JSON without repairing state", () => {
    const routesPath = path.join(stateDir, "routes.json");
    fs.writeFileSync(routesPath, "{");
    fs.writeFileSync(path.join(stateDir, "proxy.pid"), "invalid");
    const result = run();
    const report = parseReport(result);
    expect(result.status).toBe(1);
    expect(report.findings).toContainEqual({
      code: "routes.read_warning",
      status: "warn",
      message: `Corrupted routes file (invalid JSON): ${routesPath}`,
      details: { path: routesPath },
    });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "proxy.pid_invalid", status: "fail" })
    );
    expect(fs.readFileSync(routesPath, "utf-8")).toBe("{");
    expect(fs.readFileSync(path.join(stateDir, "proxy.pid"), "utf-8")).toBe("invalid");
    expect(fs.readdirSync(stateDir).sort()).toEqual(["proxy.pid", "routes.json"]);
  });

  it("reports stale routes, invalid alias ports, and unavailable backends without pruning", () => {
    const routes = [
      { hostname: "stale.localhost", port: 4001, pid: STALE_PID },
      { hostname: "bad.localhost", port: 99999, pid: 0 },
      { hostname: "waiting.localhost", port: 4002, pid: ALIVE_PID },
    ];
    const routesPath = path.join(stateDir, "routes.json");
    const original = JSON.stringify(routes);
    fs.writeFileSync(routesPath, original);
    const result = run();
    const report = parseReport(result);
    expect(result.status).toBe(0);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "routes.stale", details: { active: 2, stale: 1 } }),
        expect.objectContaining({ code: "route.stale", details: routes[0] }),
        expect.objectContaining({ code: "route.invalid_port", details: routes[1] }),
        expect.objectContaining({ code: "route.not_listening", details: routes[2] }),
      ])
    );
    expect(fs.readFileSync(routesPath, "utf-8")).toBe(original);
  });

  it("reports a missing nested state directory without creating it", () => {
    stateDir = path.join(root, "missing", "nested", "state");
    const result = run();
    const report = parseReport(result);
    expect(result.status).toBe(0);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "state.not_created", status: "info" })
    );
    expect(fs.existsSync(path.join(root, "missing"))).toBe(false);
  });

  it("reports env-only LAN mode as enabled without changing the default text mode", () => {
    stateDir = path.join(root, "missing", "state");
    const result = run(undefined, "stopped", { PORTLESS_LAN: "1" });
    const report = parseReport(result);
    const mdnsSupported = process.platform === "darwin" || process.platform === "linux";
    expect(result.status).toBe(mdnsSupported ? 0 : 1);
    expect(report.metadata.lan).toEqual({ enabled: true, ip: null });
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: mdnsSupported ? "lan.mdns_available" : "lan.mdns_unavailable",
        status: mdnsSupported ? "ok" : "fail",
      })
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "lan.ip_missing", status: "warn" })
    );
    const text = run(["doctor"], "stopped", { PORTLESS_LAN: "1" });
    expect(text.stdout).toContain("Mode: HTTP, .localhost\n");
    expect(fs.existsSync(path.join(root, "missing"))).toBe(false);
  });

  it("keeps the existing human-readable doctor report by default", () => {
    const result = run(["doctor"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("portless doctor");
    expect(result.stdout).toContain(`Proxy target: http://127.0.0.1:${PROXY_PORT}`);
    expect(result.stdout).toContain(`Proxy is not running on port ${PROXY_PORT}.`);
    expect(result.stdout).toContain("Summary: 0 failures, 1 warning.");
    expect(result.stdout).not.toContain('"schemaVersion"');
  });
});
