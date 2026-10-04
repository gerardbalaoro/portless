import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const PROXY_PORT = 23456;
const STALE_PID = 2147483647;

type RunResult = ReturnType<typeof run>;

function run(
  args: string[],
  stateDir: string,
  options?: { cwd?: string; env?: Record<string, string | undefined> }
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("PORTLESS_") || name === "PORTLESS" || name.startsWith("GIT_")) {
      delete env[name];
    }
  }
  delete env.PNPM_SCRIPT_SRC_DIR;
  delete env.npm_command;
  delete env.NODE_OPTIONS;
  delete env.FORCE_COLOR;
  Object.assign(env, {
    PORTLESS_STATE_DIR: stateDir,
    PORTLESS_PORT: String(PROXY_PORT),
    NO_COLOR: "1",
    ...options?.env,
  });
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: options?.cwd ?? stateDir,
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
}

function parseDocument(result: RunResult, command: string) {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stdout).not.toContain("\u001b");
  expect(result.stdout.endsWith("\n")).toBe(true);
  // Parsing the entire stdout rejects banners, trailing prose, and extra JSON documents.
  const document = JSON.parse(result.stdout);
  expect(document).toMatchObject({ schemaVersion: 1, command });
  return document;
}

function expectArgumentError(result: RunResult, command: string) {
  expect(result.status).toBe(1);
  const document = parseDocument(result, command);
  expect(document).toEqual({
    schemaVersion: 1,
    command,
    error: { code: "INVALID_ARGUMENT", message: expect.any(String) },
  });
  expect(document.error.message.length).toBeGreaterThan(0);
  expect(result.stderr).toBe("");
  return document;
}

describe("read-only CLI JSON output", () => {
  let root: string;
  let stateDir: string;

  beforeAll(() => {
    expect(fs.existsSync(CLI_PATH), "Build the CLI before running its integration tests").toBe(
      true
    );
    expect(() => process.kill(STALE_PID, 0)).toThrow();
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "portless-json-cli-"));
    stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(stateDir, "proxy.port"), String(PROXY_PORT));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeRoutes(routes: unknown): string {
    const source = JSON.stringify(routes, null, 2) + "\n";
    fs.writeFileSync(path.join(stateDir, "routes.json"), source);
    return source;
  }

  describe("list", () => {
    it("reports aliases, live processes, optional metadata, and filters stale routes without writes", () => {
      fs.writeFileSync(path.join(stateDir, "proxy.tls"), "1");
      const routesPath = path.join(stateDir, "routes.json");
      const source = writeRoutes([
        { hostname: "database.localhost", port: 5432, pid: 0 },
        {
          hostname: "api.localhost",
          port: 3000,
          pid: process.pid,
          tailscaleUrl: "https://api.example.ts.net",
          tailscaleHttpsPort: 8443,
          tailscaleFunnel: false,
          ngrokUrl: "https://example.ngrok.app",
          ngrokPid: process.pid,
        },
        { hostname: "stale.localhost", port: 3001, pid: STALE_PID },
      ]);
      const before = fs.statSync(routesPath);
      const result = run(["list", "--json"], stateDir, {
        env: { FORCE_COLOR: "1", NO_COLOR: undefined },
      });
      expect(result.status).toBe(0);
      expect(parseDocument(result, "list")).toEqual({
        schemaVersion: 1,
        command: "list",
        proxy: { port: PROXY_PORT, tls: true, stateDir },
        routes: [
          {
            hostname: "database.localhost",
            url: `https://database.localhost:${PROXY_PORT}`,
            port: 5432,
            pid: 0,
            alias: true,
          },
          {
            hostname: "api.localhost",
            url: `https://api.localhost:${PROXY_PORT}`,
            port: 3000,
            pid: process.pid,
            alias: false,
            tailscaleUrl: "https://api.example.ts.net",
            tailscaleHttpsPort: 8443,
            tailscaleFunnel: false,
            ngrokUrl: "https://example.ngrok.app",
            ngrokPid: process.pid,
          },
        ],
        warnings: [],
      });
      expect(fs.readFileSync(routesPath, "utf8")).toBe(source);
      expect(fs.statSync(routesPath).mtimeMs).toBe(before.mtimeMs);
      expect(fs.existsSync(path.join(stateDir, "routes.lock"))).toBe(false);
    });

    it.each(["missing", "empty"])("returns an empty route array for a %s routes file", (kind) => {
      if (kind === "empty") writeRoutes([]);
      const result = run(["list", "--json"], stateDir);
      expect(result.status).toBe(0);
      expect(parseDocument(result, "list")).toEqual({
        schemaVersion: 1,
        command: "list",
        proxy: { port: PROXY_PORT, tls: false, stateDir },
        routes: [],
        warnings: [],
      });
      expect(result.stderr).toBe("");
    });

    it.each([
      { contents: "{broken", warning: "invalid JSON" },
      { contents: '{"routes":[]}', warning: "expected array" },
    ])(
      "reports corruption in warnings without altering the file: $warning",
      ({ contents, warning }) => {
        const routesPath = path.join(stateDir, "routes.json");
        fs.writeFileSync(routesPath, contents);
        const result = run(["list", "--json"], stateDir);
        expect(result.status).toBe(0);
        const document = parseDocument(result, "list");
        expect(document.routes).toEqual([]);
        expect(document.warnings).toEqual([expect.stringContaining(warning)]);
        expect(document.warnings[0]).toContain(routesPath);
        expect(result.stderr).toBe("");
        expect(fs.readFileSync(routesPath, "utf8")).toBe(contents);
      }
    );

    it("keeps the existing human-readable list output and ignores extra operands", () => {
      writeRoutes([{ hostname: "api.localhost", port: 3000, pid: 0 }]);
      const result = run(["list", "ignored"], stateDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Active routes:");
      expect(result.stdout).toContain(`http://api.localhost:${PROXY_PORT}`);
      expect(result.stdout).toContain("localhost:3000");
      expect(result.stdout).toContain("(alias)");
      expect(result.stdout).not.toContain("schemaVersion");
      expect(result.stderr).toBe("");
    });
  });

  describe("get", () => {
    it("uses the discovered TLS mode, custom port, and first configured TLD", () => {
      fs.writeFileSync(path.join(stateDir, "proxy.tls"), "1");
      fs.writeFileSync(path.join(stateDir, "proxy.tlds"), JSON.stringify(["test", "localhost"]));
      const result = run(["get", "api.backend", "--json"], stateDir, {
        env: { FORCE_COLOR: "1", NO_COLOR: undefined },
      });
      expect(result.status).toBe(0);
      expect(parseDocument(result, "get")).toEqual({
        schemaVersion: 1,
        command: "get",
        name: "api.backend",
        hostname: "api.backend.test",
        url: `https://api.backend.test:${PROXY_PORT}`,
        proxy: { port: PROXY_PORT, tls: true },
        worktree: null,
      });
    });

    it("supports a legacy custom TLD and keeps plain get's first operand and bare URL", () => {
      fs.writeFileSync(path.join(stateDir, "proxy.tld"), "test");
      const plain = run(["get", "backend", "ignored"], stateDir);
      expect(plain.status).toBe(0);
      expect(plain.stdout).toBe(`http://backend.test:${PROXY_PORT}\n`);
      expect(plain.stderr).toBe("");
      const structured = run(["get", "--json", "backend"], stateDir);
      expect(structured.status).toBe(0);
      expect(parseDocument(structured, "get").url).toBe(plain.stdout.trim());
    });

    it("reports a worktree prefix and honors --no-worktree", () => {
      const checkout = path.join(root, "checkout");
      const gitDir = path.join(root, "repository.git", "worktrees", "feature");
      fs.mkdirSync(checkout);
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${gitDir}\n`);
      fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature/My_Branch\n");

      const result = run(["get", "--json", "backend"], stateDir, { cwd: checkout });
      expect(result.status).toBe(0);
      expect(parseDocument(result, "get")).toMatchObject({
        name: "backend",
        hostname: "my-branch.backend.localhost",
        url: `http://my-branch.backend.localhost:${PROXY_PORT}`,
        worktree: { prefix: "my-branch", source: "git branch" },
      });
      const noWorktree = run(["get", "backend", "--no-worktree", "--json"], stateDir, {
        cwd: checkout,
      });
      expect(noWorktree.status).toBe(0);
      expect(parseDocument(noWorktree, "get")).toMatchObject({
        hostname: "backend.localhost",
        url: `http://backend.localhost:${PROXY_PORT}`,
        worktree: null,
      });
    });

    it("accepts the name after an explicit separator", () => {
      const result = run(["get", "--json", "--", "backend"], stateDir);
      expect(result.status).toBe(0);
      expect(parseDocument(result, "get").name).toBe("backend");
    });

    it("reports an invalid hostname as INVALID_ARGUMENT", () => {
      const result = run(["get", "my@app", "--json"], stateDir);
      expect(result.status).toBe(1);
      expect(parseDocument(result, "get")).toEqual({
        schemaVersion: 1,
        command: "get",
        error: { code: "INVALID_ARGUMENT", message: expect.stringContaining("Invalid hostname") },
      });
      expect(result.stderr).toBe("");
    });
  });

  describe("argument parsing", () => {
    it.each([
      { args: ["--lan", "list", "--json"], command: "list" },
      { args: ["--script", "dev", "get", "--json", "backend"], command: "get" },
      { args: ["service", "--script", "dev", "status", "--json"], command: "service status" },
    ])("recognizes read commands alongside global flags: $args", ({ args, command }) => {
      const result = run(args, stateDir);
      expect(result.status).toBe(0);
      expect(parseDocument(result, command)).not.toHaveProperty("error");
    });

    it.each([
      { args: ["list", "--json", "extra"], command: "list" },
      { args: ["list", "--json", "--typo"], command: "list" },
      { args: ["list", "--json", "--json"], command: "list" },
      { args: ["get", "--json"], command: "get" },
      { args: ["get", "--json", "first", "second"], command: "get" },
      { args: ["doctor", "--json", "--typo"], command: "doctor" },
      { args: ["service", "status", "--json", "--typo"], command: "service status" },
    ])("returns a structured argument error for $args", ({ args, command }) => {
      expectArgumentError(run(args, stateDir), command);
    });

    it.each([
      { args: ["list", "--json", "--ip"], command: "list", flag: "--ip" },
      { args: ["get", "app", "--json", "--script"], command: "get", flag: "--script" },
      {
        args: ["service", "status", "--json", "--lan-ip-auto"],
        command: "service status",
        flag: "--lan-ip-auto",
      },
    ])("keeps missing global values in the JSON envelope: $args", ({ args, command, flag }) => {
      const document = expectArgumentError(run(args, stateDir), command);
      expect(document.error.message).toContain(`${flag} requires`);
      const plain = run(
        args.filter((arg) => arg !== "--json"),
        stateDir
      );
      expect(plain.status).toBe(1);
      expect(plain.stdout).toBe("");
      expect(plain.stderr).toContain(`${flag} requires`);
    });

    it.each([
      { launcher: "npx", env: { npm_command: "exec" } },
      { launcher: "pnpm dlx", env: { PNPM_SCRIPT_SRC_DIR: "dlx" } },
    ])("reports blocked $launcher execution as a JSON command failure", ({ env }) => {
      const options = { env: { ...env, npm_lifecycle_event: undefined } };
      const result = run(["list", "--json"], stateDir, options);
      expect(result.status).toBe(1);
      expect(parseDocument(result, "list")).toEqual({
        schemaVersion: 1,
        command: "list",
        error: {
          code: "COMMAND_FAILED",
          message: expect.stringContaining("should not be run via npx or pnpm dlx"),
        },
      });
      expect(result.stderr).toBe("");
      const plain = run(["list"], stateDir, options);
      expect(plain.status).toBe(1);
      expect(plain.stdout).toBe("");
      expect(plain.stderr).toContain("should not be run via npx or pnpm dlx");
    });

    it.each([
      ["list", "--json", "--help"],
      ["get", "--json", "backend", "--help"],
      ["doctor", "--help", "--json"],
      ["service", "status", "--json", "--help"],
    ])("keeps help human-readable when combined with JSON: %j", (...args) => {
      const result = run(args, stateDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`portless ${args[0]}`);
      expect(result.stdout).toContain("--json");
      expect(result.stdout).not.toContain('"schemaVersion"');
      expect(result.stderr).toBe("");
    });

    it.each([
      ["--json", "list"],
      ["service", "--json", "status"],
    ])("rejects JSON before the complete command: %j", (...args) => {
      const result = run(args, stateDir);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--json");
    });

    it("does not enable JSON for a token after the separator", () => {
      const result = run(["get", "--", "--json"], stateDir);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('Unknown flag "--"');
    });

    it("preserves a second --json token after the separator as the literal name", () => {
      const result = run(["get", "--json", "--", "--json"], stateDir);
      expect(result.status).toBe(1);
      const document = parseDocument(result, "get");
      expect(document.error.code).toBe("INVALID_ARGUMENT");
      expect(document.error.message).toContain("Invalid hostname");
      expect(document.error.message).toContain("--json");
    });

    it("does not treat help after the separator as a request for help", () => {
      const result = run(["get", "--json", "--", "--help"], stateDir);
      expect(result.status).toBe(1);
      const document = parseDocument(result, "get");
      expect(document.error.code).toBe("INVALID_ARGUMENT");
      expect(document.error.message).toContain("--help");
    });
  });

  describe("plain argument compatibility", () => {
    it.each([
      { args: ["get", "app", "--help"], error: 'Unknown flag "--help"' },
      { args: ["get", "--", "app"], error: 'Unknown flag "--"' },
      { args: ["doctor", "unknown", "--help"], error: 'Unknown argument "unknown"' },
      { args: ["doctor", "--"], error: 'Unknown argument "--"' },
    ])("preserves the existing error for $args", ({ args, error }) => {
      const result = run(args, stateDir);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(error);
    });
  });

  describe("bypass mode", () => {
    it.each([
      { args: ["list", "--json"], command: "list" },
      { args: ["get", "--json", "backend"], command: "get" },
      { args: ["doctor", "--json"], command: "doctor" },
      { args: ["service", "status", "--json"], command: "service status" },
    ])("still dispatches JSON $command when PORTLESS=0", ({ args, command }) => {
      const result = run(args, stateDir, { env: { PORTLESS: "0" } });
      const document = parseDocument(result, command);
      expect(document).not.toHaveProperty("error");
      expect(result.status).toBe(command === "doctor" && document.summary.failures > 0 ? 1 : 0);
    });

    it.each(["get", "list"])("preserves plain %s as a named command when PORTLESS=0", (name) => {
      const scriptPath = path.join(root, "capture.cjs");
      fs.writeFileSync(scriptPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
      const childArgs = ["first", "second"];
      const result = run([name, process.execPath, scriptPath, ...childArgs], stateDir, {
        env: { PORTLESS: "0" },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(childArgs);
      expect(result.stderr).toBe("");
    });

    it.each([
      { prefix: ["backend"], mode: "named" },
      { prefix: ["run"], mode: "run" },
      { prefix: ["--name", "list"], mode: "explicit-name" },
    ])("preserves child JSON flags in $mode mode", ({ prefix }) => {
      const scriptPath = path.join(root, "capture.cjs");
      fs.writeFileSync(scriptPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
      const childArgs = ["--json", "value", "--", "--json", "--help"];
      const result = run([...prefix, process.execPath, scriptPath, ...childArgs], stateDir, {
        env: { PORTLESS: "0" },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(childArgs);
      expect(result.stderr).toBe("");
    });
  });

  describe("unsupported mutation commands", () => {
    it.each([
      ["alias", "backend", "3000", "--json"],
      ["alias", "--remove", "backend", "--json"],
      ["clean", "--json"],
      ["prune", "--json"],
      ["trust", "--json"],
      ["hosts", "sync", "--json"],
      ["proxy", "start", "--json"],
      ["proxy", "stop", "--json"],
      ["service", "install", "--json"],
      ["service", "uninstall", "--json"],
    ])("rejects %j before state I/O or subprocesses", (...args) => {
      const preload = path.join(root, "guard.cjs");
      const capture = path.join(root, "effects.json");
      fs.writeFileSync(
        preload,
        [
          'const fs = require("node:fs");',
          'const cp = require("node:child_process");',
          'const { syncBuiltinESMExports } = require("node:module");',
          "const write = fs.writeFileSync;",
          "const effects = [];",
          `const stateDir = ${JSON.stringify(stateDir)};`,
          "function fail(name) { effects.push(name); throw new Error('Blocked side effect: ' + name); }",
          "for (const name of ['writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'mkdirSync', 'renameSync', 'copyFileSync', 'chmodSync', 'chownSync']) {",
          "  fs[name] = () => fail('fs.' + name);",
          "}",
          "for (const name of ['readFileSync', 'existsSync', 'accessSync', 'statSync', 'readdirSync']) {",
          "  const original = fs[name];",
          "  fs[name] = function (file, ...rest) {",
          "    if (String(file).startsWith(stateDir)) return fail('state.' + name);",
          "    return original.call(this, file, ...rest);",
          "  };",
          "}",
          "for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {",
          "  cp[name] = () => fail('child_process.' + name);",
          "}",
          "process.kill = () => fail('process.kill');",
          "syncBuiltinESMExports();",
          `process.on('exit', () => write(${JSON.stringify(capture)}, JSON.stringify(effects)));`,
        ].join("\n")
      );
      const result = run(args, stateDir, {
        env: { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--json is only supported by");
      expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toEqual([]);
    });
  });
});
