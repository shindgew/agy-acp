import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import {
  AgyCliBackend,
  AgyCliSession,
  DEFAULT_AGY_INSTALL_COMMAND,
  DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS,
  DEFAULT_CONVERSATIONS_DIR,
  configFromEnv,
  parseAgyModels,
  type AgyCliConfig,
  type SpawnFactory,
  type SpawnOptions
} from "../src/agy-cli.js";
import { createConversationDb, insertStep } from "./fixtures/conversation-db.js";
import { encodeStepPayload } from "./fixtures/step-encoder.js";

/** Collects updates via the `onUpdate` callback `AgyCliSession.prompt` takes. */
async function collectUpdates(
  session: AgyCliSession,
  prompt: string
): Promise<{ updates: SessionUpdate[]; stopReason: "end_turn" | "cancelled" }> {
  const updates: SessionUpdate[] = [];
  const outcome = await session.prompt(prompt, async (update) => {
    updates.push(update);
  });
  return { updates, stopReason: outcome.stopReason };
}

describe("commandForPrompt", () => {
  it("uses agy print mode and safe defaults", () => {
    const session = new AgyCliSession({
      ...defaultConfig(),
      workspaces: ["/repo", "/extra"],
      agyPath: "/opt/homebrew/bin/agy",
      model: "gemini-test",
      project: "project-1",
      printTimeout: "30s",
      logFile: "/tmp/agy.log"
    });

    const command = session.commandForPrompt("hello");

    expect(command[0]).toBe("/opt/homebrew/bin/agy");
    expect(command).toContain("--print");
    expect(command[command.indexOf("--print") + 1]).toBe("hello");
    expect(command).toContain("--sandbox");
    expect(flagValue(command, "--model")).toBe("gemini-test");
    expect(flagValue(command, "--project")).toBe("project-1");
    expect(flagValue(command, "--add-dir")).toBe("/extra");
  });
});

describe("configFromEnv", () => {
  it("reads the agy executable path from AGY_ACP_AGY_PATH", () => {
    const config = configFromEnv({
      cwd: "/repo",
      workspaces: ["/repo"],
      env: {
        AGY_ACP_AGY_PATH: "/bin/agy"
      }
    });

    expect(config.agyPath).toBe("/bin/agy");
    expect(config.sandbox).toBe(true);
    expect(config.skipPermissions).toBe(false);
    expect(config.promptInArgv).toBe(true);
    expect(config.autoInstall).toBe(false);
  });
});

describe("parseAgyModels", () => {
  it("filters status and log lines", () => {
    expect(parseAgyModels(`
Fetching available models...
I0701 10:23:00.894210 model_config_manager.go:157] log
Gemini 3.5 Flash (Medium)
Claude Sonnet 4.6 (Thinking)
Gemini 3.5 Flash (Medium)
  `)).toEqual(["Gemini 3.5 Flash (Medium)", "Claude Sonnet 4.6 (Thinking)"]);
  });
});

describe("listModels", () => {
  it("discovers models through agy models", async () => {
    const fake = new FakeProcess([`
Fetching available models...
Gemini 3.5 Flash (Medium)
Claude Sonnet 4.6 (Thinking)
`]);
    const calls: SpawnCall[] = [];
    const backend = new AgyCliBackend(fake.spawnFactory(calls));

    const models = await backend.listModels(defaultConfig());

    expect(models).toEqual(["Gemini 3.5 Flash (Medium)", "Claude Sonnet 4.6 (Thinking)"]);
    expect(calls[0].command).toBe("agy");
    expect(calls[0].args).toEqual(["models"]);
  });
});

describe("prompt", () => {
  it("runs the prompt in argv mode and drains stdout without reading it", async () => {
    const fake = new FakeProcess(["hello ", "world"]);
    const calls: SpawnCall[] = [];
    const session = new AgyCliSession(defaultConfig(), fake.spawnFactory(calls));

    const { updates, stopReason } = await collectUpdates(session, "hello");

    // No conversation database was written, so nothing is streamed — agy's
    // stdout is drained but never interpreted as ACP updates.
    expect(updates).toEqual([]);
    expect(stopReason).toBe("end_turn");
    expect(calls[0].args[calls[0].args.indexOf("--print") + 1]).toBe("hello");
    expect(fake.stdinText).toBe("");
    expect(fake.stdinEnded).toBe(true);
  });

  it("can write prompt through stdin", async () => {
    const fake = new FakeProcess(["ok"]);
    const calls: SpawnCall[] = [];
    const session = new AgyCliSession({ ...defaultConfig(), promptInArgv: false }, fake.spawnFactory(calls));

    await collectUpdates(session, "hello");

    expect(fake.stdinText).toBe("hello");
    expect(fake.stdinEnded).toBe(true);
    expect(calls[0].args[calls[0].args.indexOf("--print") + 1]).not.toBe("hello");
  });

  it("prepends the transient /fast command in fast mode", async () => {
    const fake = new FakeProcess(["ok"]);
    const calls: SpawnCall[] = [];
    const session = new AgyCliSession({ ...defaultConfig(), fastMode: true }, fake.spawnFactory(calls));

    await collectUpdates(session, "hello");

    expect(calls[0].args[calls[0].args.indexOf("--print") + 1]).toBe("/fast\nhello");
  });

  it("prefixes stdin prompts when prompt argv is disabled in fast mode", async () => {
    const fake = new FakeProcess(["ok"]);
    const session = new AgyCliSession(
      { ...defaultConfig(), fastMode: true, promptInArgv: false },
      fake.spawnFactory([])
    );

    await collectUpdates(session, "hello");

    expect(fake.stdinText).toBe("/fast\nhello");
  });

  it("binds the conversation id agy creates, then passes --conversation on the next turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-test-"));
    try {
      const calls: SpawnCall[] = [];
      let turn = 0;
      const session = new AgyCliSession(
        { ...defaultConfig(), conversationsDir: dir },
        (command, args, options) => {
          calls.push({ command, args, options });
          turn += 1;
          if (turn === 1) {
            const db = createConversationDb(dir, "conv-123");
            insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "hi" }) });
            db.close();
          }
          return new FakeProcess([]).spawnFactory([])(command, args, options);
        }
      );

      await collectUpdates(session, "first");
      expect(calls[0].args).not.toContain("--conversation");
      expect(session.conversationId).toBe("conv-123");

      await collectUpdates(session, "second");
      expect(calls[1].args[calls[1].args.indexOf("--conversation") + 1]).toBe("conv-123");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("raises when agy exits nonzero", async () => {
    const fake = new FakeProcess([], { stderr: ["not logged in"], exitCode: 2 });
    const session = new AgyCliSession(defaultConfig(), fake.spawnFactory([]));

    await expect(collectUpdates(session, "hello")).rejects.toThrow(/not logged in/);
  });

  it("can install agy on demand when the default executable is missing", async () => {
    const missing = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
    const processes = [
      new FakeProcess([], { spawnError: missing, exitCode: null }),
      new FakeProcess([], { exitCode: 0 }),
      new FakeProcess(["ok"])
    ];
    const calls: Array<{ command: string; args: string[] }> = [];
    const session = new AgyCliSession(
      { ...defaultConfig(), autoInstall: true },
      (command, args, options) => {
        calls.push({ command, args });
        const process = processes.shift();
        expect(process, `unexpected spawn: ${command}`).toBeDefined();
        return process!.spawnFactory([])(command, args, options);
      }
    );

    const { stopReason } = await collectUpdates(session, "hello");

    expect(stopReason).toBe("end_turn");
    expect(calls.map((call) => call.command)).toEqual(["agy", "sh", "agy"]);
    expect(calls[1].args).toEqual(["-c", DEFAULT_AGY_INSTALL_COMMAND]);
  });

  it("retries through the installer bin directory after auto install", async () => {
    const missing = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
    const processes = [
      new FakeProcess([], { spawnError: missing, exitCode: null }),
      new FakeProcess([], { exitCode: 0 }),
      new FakeProcess(["ok"])
    ];
    const calls: SpawnCall[] = [];
    const session = new AgyCliSession(
      {
        ...defaultConfig(),
        autoInstall: true,
        installBinDir: "/home/user/.local/bin",
        env: { PATH: "/usr/bin" }
      },
      (command, args, options) => {
        calls.push({ command, args, options });
        const process = processes.shift();
        expect(process, `unexpected spawn: ${command}`).toBeDefined();
        return process!.spawnFactory([])(command, args, options);
      }
    );

    await collectUpdates(session, "hello");

    expect(calls[2].options.env?.PATH).toBe("/home/user/.local/bin:/usr/bin");
  });

  it("includes install guidance when agy is missing without auto install", async () => {
    const missing = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
    const session = new AgyCliSession(
      defaultConfig(),
      new FakeProcess([], { spawnError: missing, exitCode: null }).spawnFactory([])
    );

    await expect(collectUpdates(session, "hello")).rejects.toThrow(/Install the Google Antigravity CLI/);
  });
});

describe("cancel", () => {
  it("sends SIGINT (not SIGTERM) so agy can flush its conversation database", async () => {
    const fake = new FakeProcess([], { blockStdout: true, exitCode: null });
    const session = new AgyCliSession(defaultConfig(), fake.spawnFactory([]));
    const pending = collectUpdates(session, "hello");

    await new Promise((resolve) => setImmediate(resolve));
    await session.cancel();

    expect(fake.killedWith).toBe("SIGINT");
    expect(session.wasCancelled).toBe(true);
    expect((await pending).stopReason).toBe("cancelled");
  });
});

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

function defaultConfig(): AgyCliConfig {
  return {
    cwd: "/repo",
    workspaces: ["/repo"],
    agyPath: "agy",
    printTimeout: "5m0s",
    fastMode: false,
    sandbox: true,
    skipPermissions: false,
    promptInArgv: true,
    autoInstall: false,
    installCommand: DEFAULT_AGY_INSTALL_COMMAND,
    modelList: [],
    discoverModels: true,
    modelListTimeoutMs: DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS,
    conversationsDir: DEFAULT_CONVERSATIONS_DIR
  };
}

function flagValue(command: string[], flag: string): string {
  return command[command.indexOf(flag) + 1];
}

interface FakeProcessOptions {
  stderr?: string[];
  exitCode?: number | null;
  blockStdout?: boolean;
  spawnError?: Error & { code?: string };
}

class FakeProcess extends EventEmitter {
  stdinText = "";
  stdinEnded = false;
  stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.stdinText += chunk.toString();
      callback();
    },
    final: (callback) => {
      this.stdinEnded = true;
      callback();
    }
  });
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  pid = 1;
  killedWith?: string;
  spawnError?: Error & { code?: string };

  constructor(chunks: string[], options: FakeProcessOptions = {}) {
    super();
    this.spawnError = options.spawnError;
    this.exitCode = options.exitCode === undefined ? 0 : options.exitCode;
    this.stdout = options.blockStdout ? new Readable({ read() {} }) : Readable.from(chunks);
    this.stderr = Readable.from(options.stderr ?? []);
    if (!options.blockStdout && this.exitCode !== null) {
      queueMicrotask(() => this.emit("exit", this.exitCode, null));
    }
  }

  kill(signal?: string) {
    this.killedWith = signal;
    this.exitCode = signal === "SIGKILL" ? -9 : -15;
    this.stdout.push(null);
    this.emit("exit", this.exitCode, signal ?? "SIGTERM");
    return true;
  }

  spawnFactory(calls: SpawnCall[]): SpawnFactory {
    return (command, args, options) => {
      calls.push({ command, args, options });
      if (this.spawnError) {
        queueMicrotask(() => this.emit("error", this.spawnError));
      }
      return this as unknown as ReturnType<SpawnFactory>;
    };
  }
}