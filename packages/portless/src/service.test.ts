import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import {
  buildServiceSpec,
  buildServiceUninstallSudoArgs,
  handleService,
  tryUninstallService,
} from "./service.js";

vi.mock("node:fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:fs")>();
  return {
    ...mod,
    chmodSync: vi.fn(),
    existsSync: vi.fn(mod.existsSync),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(mod.readFileSync),
    rmSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

vi.mock("./certs.js", () => ({
  ensureCerts: vi.fn(() => ({
    certPath: "/fake/server.pem",
    keyPath: "/fake/server-key.pem",
    caPath: "/fake/ca.pem",
    caGenerated: false,
  })),
  isCATrusted: vi.fn(() => true),
  trustCA: vi.fn(() => ({ trusted: true })),
}));

vi.mock("./utils.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./utils.js")>();
  return {
    ...mod,
    fixOwnership: vi.fn(),
  };
});

vi.mock("./mdns.js", () => ({
  isMdnsSupported: vi.fn(() => ({ supported: true })),
}));

vi.mock("./cli-utils.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./cli-utils.js")>();
  return {
    ...mod,
    discoverState: vi.fn(mod.discoverState),
    isProxyRunning: vi.fn(mod.isProxyRunning),
  };
});

const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
const { isMdnsSupported } = await import("./mdns.js");
const { discoverState, isProxyRunning } = await import("./cli-utils.js");
const actualCliUtils = await vi.importActual<typeof import("./cli-utils.js")>("./cli-utils.js");

const originalPlatform = process.platform;
const originalGetuid = process.getuid;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function setGetuid(uid: number): void {
  Object.defineProperty(process, "getuid", {
    configurable: true,
    value: () => uid,
  });
}

afterEach(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: originalPlatform,
  });
  Object.defineProperty(process, "getuid", {
    configurable: true,
    value: originalGetuid,
  });
  vi.mocked(existsSync).mockRestore();
  vi.mocked(mkdirSync).mockRestore();
  vi.mocked(readFileSync).mockRestore();
  vi.mocked(rmSync).mockRestore();
  vi.mocked(writeFileSync).mockRestore();
  vi.mocked(isMdnsSupported).mockReturnValue({ supported: true });
  vi.mocked(discoverState).mockReset();
  vi.mocked(discoverState).mockImplementation(actualCliUtils.discoverState);
  vi.mocked(isProxyRunning).mockReset();
  vi.mocked(isProxyRunning).mockImplementation(actualCliUtils.isProxyRunning);
});

describe("buildServiceSpec", () => {
  it("builds a macOS LaunchDaemon for the HTTPS proxy", () => {
    const spec = buildServiceSpec({
      platform: "darwin",
      nodePath: "/usr/local/bin/node",
      entryScript: "/usr/local/lib/node_modules/portless/dist/cli.js",
      userHome: "/Users/alice",
      uid: "501",
      gid: "20",
    });

    expect(spec.platform).toBe("darwin");
    if (spec.platform !== "darwin") throw new Error("Expected macOS service spec");
    expect(spec.plistPath).toBe("/Library/LaunchDaemons/sh.portless.proxy.plist");
    expect(spec.programArguments).toEqual([
      "/usr/local/bin/node",
      "/usr/local/lib/node_modules/portless/dist/cli.js",
      "proxy",
      "start",
      "--foreground",
      "--port",
      "443",
      "--https",
      "--skip-trust",
    ]);
    expect(spec.plist).toContain("<key>RunAtLoad</key>");
    expect(spec.plist).toContain("<key>KeepAlive</key>");
    expect(spec.plist).toContain("<key>PORTLESS_STATE_DIR</key>");
    expect(spec.plist).toContain("<string>/Users/alice/.portless</string>");
    expect(spec.plist).toContain("<key>SUDO_UID</key>");
    expect(spec.plist).toContain("<string>501</string>");
  });

  it("builds a Linux systemd unit for the HTTPS proxy", () => {
    const spec = buildServiceSpec({
      platform: "linux",
      nodePath: "/usr/bin/node",
      entryScript: "/usr/lib/node_modules/portless/dist/cli.js",
      userHome: "/home/alice",
      uid: "1000",
      gid: "1000",
    });

    expect(spec.platform).toBe("linux");
    if (spec.platform !== "linux") throw new Error("Expected Linux service spec");
    expect(spec.unitPath).toBe("/etc/systemd/system/portless.service");
    expect(spec.execStart).toEqual([
      "/usr/bin/node",
      "/usr/lib/node_modules/portless/dist/cli.js",
      "proxy",
      "start",
      "--foreground",
      "--port",
      "443",
      "--https",
      "--skip-trust",
    ]);
    expect(spec.unit).toContain("Description=Portless HTTPS proxy");
    expect(spec.unit).toContain('Environment=PORTLESS_STATE_DIR="/home/alice/.portless"');
    expect(spec.unit).toContain('Environment=SUDO_UID="1000"');
    expect(spec.unit).toContain(
      'ExecStart="/usr/bin/node" "/usr/lib/node_modules/portless/dist/cli.js" "proxy" "start" "--foreground" "--port" "443" "--https" "--skip-trust"'
    );
    expect(spec.unit).toContain("WantedBy=multi-user.target");
  });

  it("builds a Windows startup task for the HTTPS proxy", () => {
    const spec = buildServiceSpec({
      platform: "win32",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      entryScript: "C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\portless\\dist\\cli.js",
      userHome: "C:\\Users\\Alice",
    });

    expect(spec.platform).toBe("win32");
    if (spec.platform !== "win32") throw new Error("Expected Windows service spec");
    expect(spec.taskName).toBe("Portless Proxy");
    expect(spec.scriptPath).toBe("C:\\ProgramData\\portless\\service\\portless-service.cmd");
    expect(spec.taskXmlPath).toBe("C:\\ProgramData\\portless\\service\\portless-task.xml");
    expect(spec.createArgs).toEqual([
      "/Create",
      "/TN",
      "Portless Proxy",
      "/XML",
      "C:\\ProgramData\\portless\\service\\portless-task.xml",
      "/F",
    ]);
    expect(spec.taskXml).toContain("<BootTrigger>");
    expect(spec.taskXml).toContain("<UserId>S-1-5-18</UserId>");
    expect(spec.taskXml).toContain("<RunLevel>HighestAvailable</RunLevel>");
    expect(spec.taskXml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(spec.taskXml).toContain("<Command>cmd.exe</Command>");
    expect(spec.taskXml).toContain(
      "<Arguments>/d /s /c &quot;&quot;C:\\ProgramData\\portless\\service\\portless-service.cmd&quot;&quot;</Arguments>"
    );
    expect(spec.script).toContain("PORTLESS_STATE_DIR=C:\\Users\\Alice\\.portless");
    expect(spec.script).toContain('"C:\\Program Files\\nodejs\\node.exe"');
    expect(spec.script).toContain("proxy");
    expect(spec.script).toContain("--port");
    expect(spec.script).toContain("443");
    expect(spec.script).toContain("--https");
    expect(spec.script).toContain("--skip-trust");
  });

  it("preserves PATH in the Windows startup script", () => {
    const spec = buildServiceSpec({
      platform: "win32",
      nodePath: "C:\\nodejs\\node.exe",
      entryScript: "C:\\cli.js",
      userHome: "C:\\Users\\Alice",
      pathEnv: "C:\\Program Files\\Git\\mingw64\\bin;C:\\Tools\\100%Done",
    });

    if (spec.platform !== "win32") throw new Error("Expected Windows service spec");
    expect(spec.script).toContain(
      'set "PATH=C:\\Program Files\\Git\\mingw64\\bin;C:\\Tools\\100%%Done"'
    );
  });

  it("escapes percent signs in Windows batch env values", () => {
    const spec = buildServiceSpec({
      platform: "win32",
      nodePath: "C:\\nodejs\\node.exe",
      entryScript: "C:\\cli.js",
      userHome: "C:\\Users\\100%Done",
    });

    if (spec.platform !== "win32") throw new Error("Expected Windows service spec");
    expect(spec.script).toContain("PORTLESS_STATE_DIR=C:\\Users\\100%%Done\\.portless");
    expect(spec.script).not.toMatch(/(?<!%)%(?!%)/);
  });

  it("uses unconditional KeepAlive in the macOS plist", () => {
    const spec = buildServiceSpec({
      platform: "darwin",
      nodePath: "/usr/local/bin/node",
      entryScript: "/usr/local/lib/portless/cli.js",
      userHome: "/Users/bob",
      uid: "501",
      gid: "20",
    });

    if (spec.platform !== "darwin") throw new Error("Expected macOS service spec");
    expect(spec.plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(spec.plist).not.toContain("SuccessfulExit");
  });

  it("persists LAN and wildcard settings in a macOS LaunchDaemon", () => {
    const spec = buildServiceSpec({
      platform: "darwin",
      nodePath: "/usr/local/bin/node",
      entryScript: "/usr/local/lib/portless/cli.js",
      userHome: "/Users/alice",
      uid: "501",
      gid: "20",
      installConfig: {
        proxyPort: 8443,
        lanMode: true,
        lanIp: "192.168.1.42",
        lanIpExplicit: true,
        useWildcard: true,
      },
    });

    if (spec.platform !== "darwin") throw new Error("Expected macOS service spec");
    expect(spec.programArguments).toContain("--lan");
    expect(spec.programArguments).toContain("--ip");
    expect(spec.programArguments).toContain("192.168.1.42");
    expect(spec.programArguments).toContain("--wildcard");
    expect(spec.programArguments).toContain("8443");
    expect(spec.plist).toContain("<key>PORTLESS_LAN</key>");
    expect(spec.plist).toContain("<string>1</string>");
    expect(spec.plist).toContain("<key>PORTLESS_LAN_IP</key>");
    expect(spec.plist).toContain("<string>192.168.1.42</string>");
    expect(spec.plist).toContain("<key>PORTLESS_WILDCARD</key>");
  });

  it("persists no-TLS, custom TLD, and custom state in a Linux service", () => {
    const spec = buildServiceSpec({
      platform: "linux",
      nodePath: "/usr/bin/node",
      entryScript: "/usr/lib/node_modules/portless/dist/cli.js",
      userHome: "/home/alice",
      uid: "1000",
      gid: "1000",
      installConfig: {
        stateDir: "/srv/portless",
        proxyPort: 8080,
        useHttps: false,
        tld: "test",
        useWildcard: true,
      },
    });

    if (spec.platform !== "linux") throw new Error("Expected Linux service spec");
    expect(spec.execStart).toContain("--no-tls");
    expect(spec.execStart).toContain("--tld");
    expect(spec.execStart).toContain("test");
    expect(spec.execStart).toContain("--wildcard");
    expect(spec.unit).toContain('Environment=PORTLESS_STATE_DIR="/srv/portless"');
    expect(spec.unit).toContain('Environment=PORTLESS_PORT="8080"');
    expect(spec.unit).toContain('Environment=PORTLESS_HTTPS="0"');
    expect(spec.unit).toContain('Environment=PORTLESS_TLD="test"');
    expect(spec.stateDir).toBe("/srv/portless");
  });
});

describe("buildServiceUninstallSudoArgs", () => {
  it("builds a service-scoped sudo command that preserves user state", () => {
    const args = buildServiceUninstallSudoArgs("/fake/cli.js", {
      nodePath: "/usr/bin/node",
      home: "/Users/alice",
      env: {
        PORTLESS_STATE_DIR: "/Users/alice/.portless",
        PORTLESS_DEBUG: "1",
        OTHER_ENV: "ignored",
      },
    });

    expect(args).toEqual([
      "env",
      "PORTLESS_DEBUG=1",
      "HOME=/Users/alice",
      "PORTLESS_STATE_DIR=/Users/alice/.portless",
      "/usr/bin/node",
      "/fake/cli.js",
      "service",
      "uninstall",
    ]);
    expect(args).not.toContain("clean");
  });
});

describe("tryUninstallService", () => {
  it("returns removed: false when service is not installed", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const runner = () => ({ status: 1, stdout: "", stderr: "" });
    const result = tryUninstallService("/fake/cli.js", runner);
    expect(result.removed).toBe(false);
    expect(result.installed).toBe(false);
  });

  it("returns removed: false when runner throws", () => {
    setPlatform("linux");
    vi.mocked(existsSync).mockReturnValue(true);
    const runner = () => {
      throw new Error("spawn failed");
    };
    const result = tryUninstallService("/fake/cli.js", runner);
    vi.mocked(existsSync).mockRestore();
    expect(result.removed).toBe(false);
    expect(result.installed).toBe(true);
    expect(result.error).toContain("spawn failed");
  });

  it("marks installed services that need elevation", () => {
    setPlatform("linux");
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(rmSync).mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    const result = tryUninstallService("/fake/cli.js", runner);

    expect(result.removed).toBe(false);
    expect(result.installed).toBe(true);
    expect(result.needsElevation).toBe(true);
  });
});

describe("handleService", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("prints human help and exits 0 for normalized JSON help", async () => {
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    await expect(
      handleService(["service", "--help"], { entryScript: "/fake/cli.js", runner, json: true })
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    const output = logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(output).toContain("portless service");
    expect(output).toContain("service install");
    expect(output).toContain("service uninstall");
    expect(output).toContain("service status");
    expect(output).toContain("Status options:");
    expect(output).toContain("--json");
  });

  it("prints help and exits 0 when no subcommand is given", async () => {
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    await expect(
      handleService(["service"], { entryScript: "/fake/cli.js", runner })
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits 1 for unknown subcommand", async () => {
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    await expect(
      handleService(["service", "bogus"], { entryScript: "/fake/cli.js", runner })
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = errorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(output).toContain("bogus");
  });

  it("rejects unsupported LAN service installs before writing a Windows task", async () => {
    setPlatform("win32");
    vi.mocked(isMdnsSupported).mockReturnValue({
      supported: false,
      reason: "mDNS publishing is not supported on this platform",
    });
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    await expect(
      handleService(["service", "install", "--lan"], {
        entryScript: "/fake/cli.js",
        runner,
      })
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(runner).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
    const output = errorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(output).toContain("LAN mode requires mDNS publishing");
  });

  it("registers the Windows task with no execution time limit before starting it", async () => {
    setPlatform("win32");
    const originalUserProfile = process.env.USERPROFILE;
    const originalProgramData = process.env.ProgramData;
    process.env.USERPROFILE = "C:\\Users\\Alice";
    process.env.ProgramData = "C:\\ProgramData";
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    try {
      await handleService(["service", "install"], {
        entryScript: "C:\\cli.js",
        runner,
      });
    } finally {
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      if (originalProgramData === undefined) {
        delete process.env.ProgramData;
      } else {
        process.env.ProgramData = originalProgramData;
      }
    }

    const calls = runner.mock.calls.map(([command, args]) => ({ command, args }));
    const createIndex = calls.findIndex(
      (call) => call.command === "schtasks" && call.args[0] === "/Create"
    );
    const runIndex = calls.findIndex(
      (call) => call.command === "schtasks" && call.args[0] === "/Run"
    );
    const taskXmlWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find(
        ([file]) => file === "C:\\ProgramData\\portless\\service\\portless-task.xml"
      );

    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeGreaterThan(createIndex);
    expect(calls.some((call) => call.command === "powershell.exe")).toBe(false);
    expect(taskXmlWrite?.[1]).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(taskXmlWrite?.[2]).toBe("utf16le");
  });

  it("does not start a Windows task when atomic registration fails", async () => {
    setPlatform("win32");
    const originalUserProfile = process.env.USERPROFILE;
    const originalProgramData = process.env.ProgramData;
    process.env.USERPROFILE = "C:\\Users\\Alice";
    process.env.ProgramData = "C:\\ProgramData";
    const runner = vi.fn((command: string, args: string[]) => ({
      status: command === "schtasks" && args[0] === "/Create" ? 1 : 0,
      stdout: "",
      stderr: command === "schtasks" && args[0] === "/Create" ? "registration failed" : "",
    }));

    try {
      await expect(
        handleService(["service", "install"], {
          entryScript: "C:\\cli.js",
          runner,
        })
      ).rejects.toThrow("process.exit");
    } finally {
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      if (originalProgramData === undefined) {
        delete process.env.ProgramData;
      } else {
        process.env.ProgramData = originalProgramData;
      }
    }

    const calls = runner.mock.calls.map(([command, args]) => ({ command, args }));
    expect(calls.some((call) => call.command === "powershell.exe")).toBe(false);
    expect(calls.some((call) => call.command === "schtasks" && call.args[0] === "/Run")).toBe(
      false
    );
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("registration failed");
  });

  it("does not stop the previous Windows task when replacement registration fails", async () => {
    setPlatform("win32");
    const originalUserProfile = process.env.USERPROFILE;
    const originalProgramData = process.env.ProgramData;
    process.env.USERPROFILE = "C:\\Users\\Alice";
    process.env.ProgramData = "C:\\ProgramData";
    const runner = vi.fn((command: string, args: string[]) => ({
      status: command === "schtasks" && args[0] === "/Create" ? 1 : 0,
      stdout: "",
      stderr: command === "schtasks" && args[0] === "/Create" ? "registration failed" : "",
    }));

    try {
      await expect(
        handleService(["service", "install"], {
          entryScript: "C:\\cli.js",
          runner,
        })
      ).rejects.toThrow("process.exit");
    } finally {
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      if (originalProgramData === undefined) {
        delete process.env.ProgramData;
      } else {
        process.env.ProgramData = originalProgramData;
      }
    }

    const taskCalls = runner.mock.calls
      .filter(([command]) => command === "schtasks")
      .map(([, args]) => args[0]);
    expect(taskCalls).toEqual(["/Create"]);
    expect(taskCalls).not.toContain("/Delete");
    expect(
      runner.mock.calls.some(
        ([command, args]) =>
          command === process.execPath && args.join(" ") === "C:\\cli.js proxy stop --port 443"
      )
    ).toBe(false);
  });

  it("keeps an atomically registered Windows task when immediate start fails", async () => {
    setPlatform("win32");
    const originalUserProfile = process.env.USERPROFILE;
    const originalProgramData = process.env.ProgramData;
    process.env.USERPROFILE = "C:\\Users\\Alice";
    process.env.ProgramData = "C:\\ProgramData";
    const runner = vi.fn((command: string, args: string[]) => ({
      status: command === "schtasks" && args[0] === "/Run" ? 1 : 0,
      stdout: "",
      stderr: "",
    }));

    try {
      await handleService(["service", "install"], {
        entryScript: "C:\\cli.js",
        runner,
      });
    } finally {
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      if (originalProgramData === undefined) {
        delete process.env.ProgramData;
      } else {
        process.env.ProgramData = originalProgramData;
      }
    }

    const calls = runner.mock.calls.map(([command, args]) => ({ command, args }));
    expect(calls.some((call) => call.command === "schtasks" && call.args[0] === "/Create")).toBe(
      true
    );
    expect(calls.some((call) => call.command === "schtasks" && call.args[0] === "/Delete")).toBe(
      false
    );
    expect(logSpy.mock.calls.flat().join(" ")).toContain("Portless service installed.");
  });

  it("removes Windows service files even when no task was registered", async () => {
    setPlatform("win32");
    const originalUserProfile = process.env.USERPROFILE;
    const originalProgramData = process.env.ProgramData;
    process.env.USERPROFILE = "C:\\Users\\Alice";
    process.env.ProgramData = "C:\\ProgramData";
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 1,
      stdout: "",
      stderr: "",
    }));

    try {
      await handleService(["service", "uninstall"], {
        entryScript: "C:\\cli.js",
        runner,
      });
    } finally {
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      if (originalProgramData === undefined) {
        delete process.env.ProgramData;
      } else {
        process.env.ProgramData = originalProgramData;
      }
    }

    expect(rmSync).toHaveBeenCalledWith("C:\\ProgramData\\portless\\service", {
      recursive: true,
      force: true,
    });
  });

  it("repeated Windows installs always register the PT0S task definition", async () => {
    setPlatform("win32");
    const originalUserProfile = process.env.USERPROFILE;
    const originalProgramData = process.env.ProgramData;
    process.env.USERPROFILE = "C:\\Users\\Alice";
    process.env.ProgramData = "C:\\ProgramData";
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    try {
      await handleService(["service", "install"], {
        entryScript: "C:\\cli.js",
        runner,
      });
      await handleService(["service", "install"], {
        entryScript: "C:\\cli.js",
        runner,
      });
    } finally {
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      if (originalProgramData === undefined) {
        delete process.env.ProgramData;
      } else {
        process.env.ProgramData = originalProgramData;
      }
    }

    const taskXmlWrites = vi
      .mocked(writeFileSync)
      .mock.calls.filter(
        ([file]) => file === "C:\\ProgramData\\portless\\service\\portless-task.xml"
      );
    const createCalls = runner.mock.calls.filter(
      ([command, args]) => command === "schtasks" && args[0] === "/Create"
    );
    expect(taskXmlWrites).toHaveLength(2);
    expect(
      taskXmlWrites.every(([, content]) =>
        String(content).includes("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>")
      )
    ).toBe(true);
    expect(taskXmlWrites.every(([, , encoding]) => encoding === "utf16le")).toBe(true);
    expect(createCalls).toHaveLength(2);
    expect(createCalls.every(([, args]) => args.includes("/XML"))).toBe(true);
  });

  it("stops an existing proxy before restarting the Linux service", async () => {
    setPlatform("linux");
    setGetuid(0);
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    await handleService(["service", "install"], {
      entryScript: "/fake/cli.js",
      runner,
    });

    const calls = runner.mock.calls.map(([command, args]) => ({ command, args }));
    const stopIndex = calls.findIndex(
      (call) =>
        call.command === process.execPath &&
        call.args.join(" ") === "/fake/cli.js proxy stop --port 443"
    );
    const restartIndex = calls.findIndex(
      (call) => call.command === "systemctl" && call.args.join(" ") === "restart portless.service"
    );

    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(restartIndex).toBeGreaterThan(stopIndex);
  });

  it("uses install flags when stopping an existing proxy before restart", async () => {
    setPlatform("linux");
    setGetuid(0);
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    await handleService(["service", "install", "--port", "8443", "--wildcard"], {
      entryScript: "/fake/cli.js",
      runner,
    });

    const calls = runner.mock.calls.map(([command, args]) => ({ command, args }));
    expect(calls).toContainEqual({
      command: process.execPath,
      args: ["/fake/cli.js", "proxy", "stop", "--port", "8443"],
    });
  });

  it("stops the discovered proxy before a different install port", async () => {
    setPlatform("linux");
    setGetuid(0);
    const currentPort = 19000;
    const targetPort = 19001;
    vi.mocked(discoverState).mockResolvedValue({
      dir: "/tmp/portless-service-current-test",
      port: currentPort,
      tls: true,
      tld: "localhost",
      tlds: ["localhost"],
      lanMode: false,
      lanIp: null,
    });
    vi.mocked(isProxyRunning).mockImplementation(async (port) => port === currentPort);
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    await handleService(["service", "install", "--port", targetPort.toString()], {
      entryScript: "/fake/cli.js",
      runner,
    });

    const stopPorts = runner.mock.calls
      .filter(
        ([command, args]) =>
          command === process.execPath &&
          args[0] === "/fake/cli.js" &&
          args[1] === "proxy" &&
          args[2] === "stop"
      )
      .map(([, args]) => args[4]);
    expect(stopPorts).toEqual([currentPort.toString(), targetPort.toString()]);
  });

  it("does not validate proxy env while uninstalling", async () => {
    setPlatform("linux");
    setGetuid(0);
    const originalPort = process.env.PORTLESS_PORT;
    const originalTld = process.env.PORTLESS_TLD;
    process.env.PORTLESS_PORT = "abc";
    process.env.PORTLESS_TLD = "bad-name";
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    try {
      await handleService(["service", "uninstall"], {
        entryScript: "/fake/cli.js",
        runner,
      });
    } finally {
      if (originalPort === undefined) {
        delete process.env.PORTLESS_PORT;
      } else {
        process.env.PORTLESS_PORT = originalPort;
      }
      if (originalTld === undefined) {
        delete process.env.PORTLESS_TLD;
      } else {
        process.env.PORTLESS_TLD = originalTld;
      }
    }

    expect(exitSpy).not.toHaveBeenCalled();
    expect(runner).toHaveBeenCalledWith("systemctl", ["disable", "--now", "portless.service"]);
  });

  it("normalizes relative install paths before writing the Linux service", async () => {
    setPlatform("linux");
    setGetuid(0);
    const runner = vi.fn((_: string, _args: string[]) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    await handleService(
      [
        "service",
        "install",
        "--state-dir",
        "relative-state",
        "--cert",
        "cert.pem",
        "--key",
        "key.pem",
      ],
      {
        entryScript: "/fake/cli.js",
        runner,
      }
    );

    const stateDir = path.resolve("relative-state");
    const certPath = path.resolve("cert.pem");
    const keyPath = path.resolve("key.pem");
    const systemdStateDir = stateDir.replace(/\\/g, "\\\\");
    const systemdCertPath = certPath.replace(/\\/g, "\\\\");
    const systemdKeyPath = keyPath.replace(/\\/g, "\\\\");
    const unitWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find(([file]) => file === "/etc/systemd/system/portless.service");
    const unit = String(unitWrite?.[1] ?? "");

    expect(mkdirSync).toHaveBeenCalledWith(stateDir, { recursive: true });
    expect(unit).toContain(`Environment=PORTLESS_STATE_DIR="${systemdStateDir}"`);
    expect(unit).toContain(`"--cert" "${systemdCertPath}" "--key" "${systemdKeyPath}"`);
  });

  it("prints installed service config from a Linux unit", async () => {
    setPlatform("linux");
    setGetuid(0);
    const installedSpec = buildServiceSpec({
      platform: "linux",
      nodePath: process.execPath,
      entryScript: "/fake/cli.js",
      userHome: "/home/alice",
      installConfig: {
        stateDir: "/srv/portless",
        proxyPort: 8443,
        useHttps: false,
        lanMode: true,
        lanIp: "192.168.1.42",
        lanIpExplicit: true,
        useWildcard: true,
      },
    });
    if (installedSpec.platform !== "linux") throw new Error("Expected Linux service spec");

    vi.mocked(existsSync).mockImplementation((file) => file === installedSpec.unitPath);
    vi.mocked(readFileSync).mockImplementation((file) => {
      if (file === installedSpec.unitPath) return installedSpec.unit;
      return "";
    });
    const runner = vi.fn((command: string, args: string[]) => {
      if (command === "systemctl" && args[0] === "is-enabled") {
        return { status: 0, stdout: "enabled\n", stderr: "" };
      }
      if (command === "systemctl" && args[0] === "is-active") {
        return { status: 1, stdout: "inactive\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    await handleService(["service", "status"], {
      entryScript: "/fake/cli.js",
      runner,
    });

    const output = logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(output).toContain("Proxy on 8443");
    expect(output).toContain("HTTPS: no");
    expect(output).toContain("TLDs: .local");
    expect(output).toContain("LAN mode: yes");
    expect(output).toContain("LAN IP: 192.168.1.42");
    expect(output).toContain("Wildcard: yes");
    expect(output).toContain("State directory: /srv/portless");
  });

  it.each([["unexpected"], ["--help"], ["--", "--json"]])(
    "ignores plain status trailing arguments %j",
    async (...trailingArgs) => {
      setPlatform("linux");
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(isProxyRunning).mockResolvedValue(false);
      const runner = vi.fn(() => ({ status: 1, stdout: "", stderr: "" }));

      await handleService(["service", "status", ...trailingArgs], {
        entryScript: "/fake/cli.js",
        runner,
      });

      const output = logSpy.mock.calls.flat().join(" ");
      expect(output).toContain("Manager state: not installed");
      expect(output).toContain("Installed: no");
      expect(output).not.toContain("Status options:");
      expect(runner).toHaveBeenCalledWith("systemctl", ["is-active", "portless.service"]);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    }
  );
});

describe("handleService JSON status", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(isProxyRunning).mockResolvedValue(false);
    vi.stubEnv("PORTLESS_STATE_DIR", "/fake/default-state");
    vi.stubEnv("ProgramData", "C:\\ProgramData");
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  function readOutput() {
    const output = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(output).toMatch(/\n$/);
    expect(output).not.toContain("\x1b");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    return JSON.parse(output);
  }

  describe.each(["darwin", "linux", "win32"] as const)("%s", (platform) => {
    it.each([
      { installed: true, proxyRunning: true },
      { installed: true, proxyRunning: false },
      { installed: false, proxyRunning: false },
      { installed: false, proxyRunning: true },
    ])("reports installed=$installed, proxyRunning=$proxyRunning", async (state) => {
      setPlatform(platform);
      const spec = buildServiceSpec({
        platform,
        nodePath: process.execPath,
        entryScript: "/fake/cli.js",
        userHome: "/fake/home",
        installConfig: {
          stateDir: "/fake/installed-state",
          proxyPort: 8443,
          useHttps: true,
          tlds: ["localhost", "test"],
          useWildcard: true,
          customCertPath: "/private/cert.pem",
          customKeyPath: "/private/key.pem",
          extraEnv: { PORTLESS_SYNC_HOSTS: "1" },
        },
      });
      const file =
        spec.platform === "darwin"
          ? spec.plistPath
          : spec.platform === "linux"
            ? spec.unitPath
            : spec.scriptPath;
      const contents =
        spec.platform === "darwin"
          ? spec.plist
          : spec.platform === "linux"
            ? spec.unit
            : spec.script;
      vi.mocked(existsSync).mockImplementation(
        (candidate) => state.installed && candidate === file
      );
      vi.mocked(readFileSync).mockImplementation((candidate) =>
        candidate === file ? contents : ""
      );
      vi.mocked(isProxyRunning).mockResolvedValue(state.proxyRunning);
      const runner = vi.fn(() => ({
        status: state.installed ? 0 : 1,
        stdout:
          platform === "darwin"
            ? "state = running\npid = 42\n"
            : platform === "linux"
              ? "active\n"
              : "Status: Running\n",
        stderr: "",
      }));

      await handleService(["service", "status"], {
        entryScript: "/fake/cli.js",
        runner,
        json: true,
      });

      const output = readOutput();
      expect(output).toEqual({
        schemaVersion: 1,
        command: "service status",
        installed: state.installed,
        managerState: state.installed
          ? platform === "darwin"
            ? "running"
            : platform === "linux"
              ? "active"
              : "Running"
          : "not installed",
        proxyRunning: state.proxyRunning,
        platform,
        config: {
          proxyPort: state.installed ? 8443 : 443,
          useHttps: true,
          tlds: state.installed ? ["localhost", "test"] : ["localhost"],
          lanMode: false,
          lanIp: null,
          useWildcard: state.installed,
          stateDir: state.installed ? "/fake/installed-state" : "/fake/default-state",
        },
        serviceEntry:
          spec.platform === "darwin"
            ? spec.plistPath
            : spec.platform === "linux"
              ? spec.unitPath
              : spec.taskName,
      });
      expect(JSON.stringify(output)).not.toContain("/private/");
      expect(JSON.stringify(output)).not.toContain("PORTLESS_SYNC_HOSTS");
      expect(isProxyRunning).toHaveBeenCalledWith(state.installed ? 8443 : 443, true);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  it("reports the installed LAN config", async () => {
    setPlatform("linux");
    const spec = buildServiceSpec({
      platform: "linux",
      nodePath: process.execPath,
      entryScript: "/fake/cli.js",
      userHome: "/fake/home",
      installConfig: {
        stateDir: "/fake/lan-state",
        proxyPort: 8080,
        useHttps: false,
        lanMode: true,
        lanIp: "192.168.1.42",
        lanIpExplicit: true,
      },
    });
    if (spec.platform !== "linux") throw new Error("Expected Linux service spec");
    vi.mocked(existsSync).mockImplementation((file) => file === spec.unitPath);
    vi.mocked(readFileSync).mockReturnValue(spec.unit);
    const runner = vi.fn(() => ({ status: 1, stdout: "inactive\n", stderr: "" }));

    await handleService(["service", "status"], {
      entryScript: "/fake/cli.js",
      runner,
      json: true,
    });

    expect(readOutput()).toMatchObject({
      installed: true,
      managerState: "installed",
      proxyRunning: false,
      config: {
        proxyPort: 8080,
        useHttps: false,
        tlds: ["local"],
        lanMode: true,
        lanIp: "192.168.1.42",
        useWildcard: false,
        stateDir: "/fake/lan-state",
      },
    });
    expect(isProxyRunning).toHaveBeenCalledWith(8080, false);
  });

  it("reports runtime failures as one JSON error", async () => {
    setPlatform("linux");
    const runner = vi.fn(() => {
      throw new Error("service manager unavailable");
    });
    await expect(
      handleService(["service", "status"], {
        entryScript: "/fake/cli.js",
        runner,
        json: true,
      })
    ).rejects.toThrow("process.exit");

    expect(readOutput()).toEqual({
      schemaVersion: 1,
      command: "service status",
      error: { code: "COMMAND_FAILED", message: "service manager unavailable" },
    });
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("reports unsupported platforms as JSON errors", async () => {
    setPlatform("freebsd");
    const runner = vi.fn(() => ({ status: 0 }));
    await expect(
      handleService(["service", "status"], { entryScript: "/fake/cli.js", runner, json: true })
    ).rejects.toThrow("process.exit");

    expect(readOutput()).toEqual({
      schemaVersion: 1,
      command: "service status",
      error: { code: "COMMAND_FAILED", message: "Unsupported platform: freebsd" },
    });
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
    expect(runner).not.toHaveBeenCalled();
    expect(isProxyRunning).not.toHaveBeenCalled();
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "reports %s service-manager spawn failures as JSON errors",
    async (platform) => {
      setPlatform(platform);
      const runner = vi.fn(() => ({
        status: null,
        error: new Error("spawn service manager ENOENT"),
      }));
      await expect(
        handleService(["service", "status"], { entryScript: "/fake/cli.js", runner, json: true })
      ).rejects.toThrow("process.exit");

      expect(readOutput()).toEqual({
        schemaVersion: 1,
        command: "service status",
        error: { code: "COMMAND_FAILED", message: "spawn service manager ENOENT" },
      });
      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
    }
  );

  it("reports Linux active-status spawn failures as JSON errors", async () => {
    setPlatform("linux");
    const runner = vi.fn((_: string, args: string[]) =>
      args[0] === "is-active"
        ? { status: null, error: new Error("spawn systemctl ETIMEDOUT") }
        : { status: 0, stdout: "enabled\n" }
    );
    await expect(
      handleService(["service", "status"], { entryScript: "/fake/cli.js", runner, json: true })
    ).rejects.toThrow("process.exit");

    expect(readOutput()).toEqual({
      schemaVersion: 1,
      command: "service status",
      error: { code: "COMMAND_FAILED", message: "spawn systemctl ETIMEDOUT" },
    });
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "preserves plain %s output when the service manager cannot be spawned",
    async (platform) => {
      setPlatform(platform);
      const runner = vi.fn(() => ({
        status: null,
        error: new Error("spawn service manager ENOENT"),
      }));
      await handleService(["service", "status"], { entryScript: "/fake/cli.js", runner });

      expect(logSpy.mock.calls.flat().join(" ")).toContain("Installed: no");
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    }
  );
});
