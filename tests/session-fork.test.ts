import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { client as acpClient, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import {
  AcpAgent,
  createAcpApp,
  createAcpV2App
} from "../src/agent.js";
import { forkConversation } from "../src/agy/db/fork.js";
import { createConversationDb, insertStep } from "./fixtures/conversation-db.js";
import { encodeStepPayload, encodeToolCall, encodeToolRun } from "./fixtures/step-encoder.js";
import * as installer from "../src/agy/installer.js";
import type { ForkSessionResponse as V1ForkSessionResponse } from "@agentclientprotocol/sdk";
import type { ForkSessionResponse as V2ForkSessionResponse } from "@agentclientprotocol/sdk/experimental/v2";
import type { SpawnFactory } from "../src/agy/cli.js";

class FakeProcess extends EventEmitter {
  stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  stdout: Readable;
  stderr: Readable;
  exitCode = 0;
  pid = 1;

  constructor(
    chunks: string[],
    options: { exitCode?: number; stderr?: string } = {}
  ) {
    super();
    this.exitCode = options.exitCode ?? 0;
    this.stdout = Readable.from(chunks);
    this.stderr = Readable.from(options.stderr ? [options.stderr] : []);
    queueMicrotask(() => this.emit("exit", this.exitCode, null));
  }

  kill() {
    this.exitCode = -15;
    this.emit("exit", -15, "SIGTERM");
    return true;
  }
}

const TEST_MODELS = "gemini-2.5-flash\ngemini-3.7-pro\n";

function makeSpawnProcess() {
  return (_command: string, args: string[]) => {
    if (args[0] === "models") {
      return new FakeProcess([TEST_MODELS]);
    }
    return new FakeProcess(["ok"]);
  };
}

function spawnAgyWritingConversation(
  dir: string,
  conversationId: string,
  steps: Parameters<typeof insertStep>[1][]
): SpawnFactory {
  return ((command: string, args: string[]) => {
    if (args[0] === "models") {
      return new FakeProcess([TEST_MODELS]);
    }
    const db = createConversationDb(dir, conversationId);
    for (const step of steps) insertStep(db, step);
    db.close();
    return new FakeProcess([]);
  }) as unknown as SpawnFactory;
}

function flushDeferredNotifications(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("forkConversation", () => {
  it("duplicates sqlite conversation db, updates trajectory_meta, and copies brain artifacts", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-test-"));
    const convDir = path.join(tmpDir, "conversations");
    const brainDir = path.join(tmpDir, "brain");
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(brainDir, { recursive: true });

    try {
      const srcId = "src-conv-1234";
      const targetId = "target-conv-5678";

      // 1. Create source conversation DB with steps and trajectory_meta
      createConversationDb(convDir, srcId);
      const srcDbPath = path.join(convDir, `${srcId}.db`);
      const srcDb = new Database(srcDbPath);
      srcDb.exec(`
        CREATE TABLE IF NOT EXISTS trajectory_meta (
          trajectory_id text,
          cascade_id text,
          trajectory_type integer,
          source integer,
          PRIMARY KEY (trajectory_id)
        );
        INSERT INTO trajectory_meta VALUES ('traj-1', '${srcId}', 4, 17);
      `);
      insertStep(srcDb, {
        idx: 0,
        stepType: 1,
        status: 3,
        stepPayload: encodeStepPayload({ userPrompt: "initial prompt" })
      });
      insertStep(srcDb, {
        idx: 1,
        stepType: 2,
        status: 3,
        stepPayload: encodeStepPayload({ agentText: "agent response" })
      });
      srcDb.close();

      // 2. Create source brain directory with artifacts
      const srcBrainPath = path.join(brainDir, srcId);
      fs.mkdirSync(srcBrainPath, { recursive: true });
      fs.writeFileSync(path.join(srcBrainPath, "plan.md"), "# Initial Plan\n- [ ] Task 1");

      // 3. Fork conversation
      await forkConversation(convDir, srcId, targetId, brainDir);

      // 4. Verify target conversation DB
      const targetDbPath = path.join(convDir, `${targetId}.db`);
      expect(fs.existsSync(targetDbPath)).toBe(true);

      const targetDb = new Database(targetDbPath, { readonly: true });
      const targetMeta = targetDb.prepare("SELECT * FROM trajectory_meta").all() as Array<{
        cascade_id: string;
        trajectory_id: string;
      }>;
      expect(targetMeta).toHaveLength(1);
      expect(targetMeta[0]?.cascade_id).toBe(targetId);

      const targetSteps = targetDb.prepare("SELECT idx, step_type FROM steps ORDER BY idx").all() as Array<{
        idx: number;
        step_type: number;
      }>;
      expect(targetSteps).toEqual([
        { idx: 0, step_type: 1 },
        { idx: 1, step_type: 2 }
      ]);
      targetDb.close();

      // 5. Verify target brain directory
      const targetBrainPath = path.join(brainDir, targetId);
      expect(fs.existsSync(targetBrainPath)).toBe(true);
      expect(fs.readFileSync(path.join(targetBrainPath, "plan.md"), "utf-8")).toBe(
        "# Initial Plan\n- [ ] Task 1"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects fork when source conversation db does not exist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-test-"));
    try {
      await expect(
        forkConversation(path.join(tmpDir, "conv"), "non-existent-src", "target-id", path.join(tmpDir, "brain"))
      ).rejects.toThrow("Source conversation database not found: non-existent-src");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("ACP v1 session/fork", () => {
  it("advertises fork capability in v1 initialize response", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue("/opt/homebrew/bin/agy");
    const connection = acpClient({ name: "test-client" }).connect(
      createAcpApp({
        argv: ["--no-interactive-permissions"],
        spawnProcess: makeSpawnProcess() as unknown as SpawnFactory
      })
    );
    try {
      const response = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {}
      });
      expect(response.agentCapabilities?.sessionCapabilities?.fork).toEqual({});
    } finally {
      installSpy.mockRestore();
      connection.close();
    }
  });

  it("forks an idle unstarted session into a new independent session", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue("/opt/homebrew/bin/agy");
    const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-v1-state-"));
    const agent = new AcpAgent({
      stateDir: tmpStateDir,
      argv: ["--no-interactive-permissions"],
      spawnProcess: makeSpawnProcess() as unknown as SpawnFactory
    });
    const connection = acpClient({ name: "test-client" }).connect(createAcpApp(agent));

    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {}
      });

      // Create parent session
      const parent = await connection.agent.request(methods.agent.session.new, {
        cwd: "/parent/workspace",
        mcpServers: []
      });
      await flushDeferredNotifications();

      // Change config on parent session
      await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: parent.sessionId,
        configId: "model",
        value: "gemini-3.7-pro"
      });

      // Fork parent session
      const forked = (await connection.agent.request(methods.agent.session.fork, {
        sessionId: parent.sessionId,
        cwd: "/forked/workspace"
      })) as V1ForkSessionResponse;
      await flushDeferredNotifications();

      expect(forked.sessionId).toBeDefined();
      expect(forked.sessionId).not.toBe(parent.sessionId);

      // Verify inherited config options on forked session
      const modelOption = forked.configOptions?.find((opt) => opt.id === "model");
      expect(modelOption?.id).toBe("model");
      expect(modelOption?.currentValue).toMatch(/gemini-3.7-pro|Gemini 3.7 Pro/i);

      // Verify sessions are listed separately
      const list = await connection.agent.request(methods.agent.session.list, {});
      expect(list.sessions).toHaveLength(2);
      expect(list.sessions.map((s) => s.sessionId)).toContain(parent.sessionId);
      expect(list.sessions.map((s) => s.sessionId)).toContain(forked.sessionId);
    } finally {
      installSpy.mockRestore();
      connection.close();
      fs.rmSync(tmpStateDir, { recursive: true, force: true });
    }
  });

  it("forks an active conversation session and duplicates conversation history", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue("/opt/homebrew/bin/agy");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-v1-active-"));
    const convDir = path.join(tmpDir, "conversations");
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    const parentConvId = "parent-conv-uuid";
    const spawnProcess = spawnAgyWritingConversation(convDir, parentConvId, [
      {
        idx: 1,
        stepType: 8,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({
            call: encodeToolCall({
              callId: "view-1",
              namePrimary: "view_file",
              rawInputJson: '{"AbsolutePath":"/repo/README.md"}'
            })
          })
        })
      },
      { idx: 2, stepType: 15, stepPayload: encodeStepPayload({ agentText: "hello from agent" }) }
    ]);

    const agent = new AcpAgent({
      stateDir,
      conversationsDir: convDir,
      argv: ["--no-interactive-permissions"],
      spawnProcess
    });

    const connection = acpClient({ name: "test-client" }).connect(createAcpApp(agent));

    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {}
      });

      // Create parent session and execute first prompt turn to bind to parentConvId
      const parent = await connection.agent.request(methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: []
      });
      await flushDeferredNotifications();

      await connection.agent.request(methods.agent.session.prompt, {
        sessionId: parent.sessionId,
        prompt: [{ type: "text", text: "tell me a joke" }]
      });

      // Fork parent session
      const forked = (await connection.agent.request(methods.agent.session.fork, {
        sessionId: parent.sessionId,
        cwd: "/forked-workspace"
      })) as V1ForkSessionResponse;
      await flushDeferredNotifications();

      expect(forked.sessionId).toBeDefined();
      expect(forked.sessionId).not.toBe(parent.sessionId);

      // Verify forked session's conversation ID on disk is a new UUID and contains parent steps
      const storeAfterFork = JSON.parse(fs.readFileSync(path.join(stateDir, "sessions.json"), "utf-8"));
      const forkedConvId = storeAfterFork.sessions[forked.sessionId].conversationId;
      expect(forkedConvId).toBeDefined();
      expect(forkedConvId).not.toBe(parentConvId);

      const forkedDbPath = path.join(convDir, `${forkedConvId}.db`);
      expect(fs.existsSync(forkedDbPath)).toBe(true);

      const forkedDb = new Database(forkedDbPath, { readonly: true });
      const forkedSteps = forkedDb.prepare("SELECT idx, step_type FROM steps ORDER BY idx").all();
      expect(forkedSteps).toHaveLength(2);
      forkedDb.close();
    } finally {
      installSpy.mockRestore();
      connection.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects fork when parent session turn is active", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue("/opt/homebrew/bin/agy");
    const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-v1-busy-"));

    const hangingProcess = new EventEmitter() as any;
    hangingProcess.stdin = new Writable({ write: (_c, _e, cb) => cb() });
    hangingProcess.stdout = new Readable({ read() {} });
    hangingProcess.stderr = new Readable({ read() {} });
    hangingProcess.exitCode = 0;
    hangingProcess.pid = 123;
    hangingProcess.kill = () => true;

    const spawnProcess = ((command: string, args: string[]) => {
      if (args[0] === "models") return new FakeProcess([TEST_MODELS]);
      return hangingProcess;
    }) as unknown as SpawnFactory;

    const agent = new AcpAgent({
      stateDir: tmpStateDir,
      argv: ["--no-interactive-permissions"],
      spawnProcess
    });
    const connection = acpClient({ name: "test-client" }).connect(createAcpApp(agent));

    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {}
      });

      const parent = await connection.agent.request(methods.agent.session.new, {
        cwd: "/parent/workspace",
        mcpServers: []
      });
      await flushDeferredNotifications();

      // Start prompt turn without awaiting completion
      const promptPromise = connection.agent.request(methods.agent.session.prompt, {
        sessionId: parent.sessionId,
        prompt: [{ type: "text", text: "run slow task" }]
      });

      // Attempt to fork parent session while turn is active
      await expect(
        connection.agent.request(methods.agent.session.fork, {
          sessionId: parent.sessionId,
          cwd: "/forked/workspace"
        })
      ).rejects.toThrow();

      // Terminate hanging turn
      hangingProcess.emit("exit", 0, null);
      await promptPromise.catch(() => {});
    } finally {
      installSpy.mockRestore();
      connection.close();
      fs.rmSync(tmpStateDir, { recursive: true, force: true });
    }
  });

  it("holds turn reservation on parent session during fork and releases cleanly", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue("/opt/homebrew/bin/agy");
    const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-v1-res-"));

    const agent = new AcpAgent({
      stateDir: tmpStateDir,
      argv: ["--no-interactive-permissions"],
      spawnProcess: makeSpawnProcess() as unknown as SpawnFactory
    });
    const connection = acpClient({ name: "test-client" }).connect(createAcpApp(agent));

    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {}
      });

      const parent = await connection.agent.request(methods.agent.session.new, {
        cwd: "/parent/workspace",
        mcpServers: []
      });
      await flushDeferredNotifications();

      const forked = (await connection.agent.request(methods.agent.session.fork, {
        sessionId: parent.sessionId,
        cwd: "/forked/workspace"
      })) as V1ForkSessionResponse;
      expect(forked.sessionId).toBeDefined();

      // Ensure parent session is completely idle and clean after fork
      await expect(
        connection.agent.request(methods.agent.session.prompt, {
          sessionId: parent.sessionId,
          prompt: [{ type: "text", text: "hello after fork" }]
        })
      ).resolves.toBeDefined();
    } finally {
      installSpy.mockRestore();
      connection.close();
      fs.rmSync(tmpStateDir, { recursive: true, force: true });
    }
  });

  it("returns an error when forking a non-existent session", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue("/opt/homebrew/bin/agy");
    const connection = acpClient({ name: "test-client" }).connect(
      createAcpApp({
        argv: ["--no-interactive-permissions"],
        spawnProcess: makeSpawnProcess() as unknown as SpawnFactory
      })
    );
    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {}
      });

      await expect(
        connection.agent.request(methods.agent.session.fork, {
          sessionId: "unknown-session-id"
        })
      ).rejects.toThrow();
    } finally {
      installSpy.mockRestore();
      connection.close();
    }
  });
});

describe("ACP v2 session/fork", () => {
  it("advertises fork capability in v2 initialize response", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue("/opt/homebrew/bin/agy");
    const connection = acpV2.client({ name: "test-client" }).connect(
      createAcpV2App({
        argv: ["--no-interactive-permissions"],
        spawnProcess: makeSpawnProcess() as unknown as SpawnFactory
      })
    );
    try {
      const response = (await connection.agent.request(acpV2.methods.agent.initialize, {
        protocolVersion: acpV2.PROTOCOL_VERSION,
        info: { name: "test-client-v2", version: "0.0.0" },
        capabilities: {}
      })) as acpV2.InitializeResponse;
      expect(response.capabilities?.session).toMatchObject({
        fork: {}
      });
    } finally {
      installSpy.mockRestore();
      connection.close();
    }
  });

  it("forks a session in v2 returning sessionId and configOptions", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue("/opt/homebrew/bin/agy");
    const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-v2-state-"));
    const agent = new AcpAgent({
      stateDir: tmpStateDir,
      argv: ["--no-interactive-permissions"],
      spawnProcess: makeSpawnProcess() as unknown as SpawnFactory
    });
    const connection = acpV2.client({ name: "test-client" }).connect(createAcpV2App(agent));

    try {
      await connection.agent.request(acpV2.methods.agent.initialize, {
        protocolVersion: acpV2.PROTOCOL_VERSION,
        info: { name: "test-client-v2", version: "0.0.0" },
        capabilities: {}
      });

      const parent = await connection.agent.request(acpV2.methods.agent.session.new, {
        cwd: "/v2/workspace"
      });
      await flushDeferredNotifications();

      const forked = (await connection.agent.request(acpV2.methods.agent.session.fork, {
        sessionId: parent.sessionId,
        cwd: "/v2/forked-workspace"
      })) as V2ForkSessionResponse;
      await flushDeferredNotifications();

      expect(forked.sessionId).toBeDefined();
      expect(forked.sessionId).not.toBe(parent.sessionId);
      expect(forked.configOptions?.length).toBeGreaterThan(0);

      const modelOption = forked.configOptions?.find((opt) => opt.configId === "model");
      expect(modelOption).toMatchObject({
        configId: "model"
      });
    } finally {
      installSpy.mockRestore();
      connection.close();
      fs.rmSync(tmpStateDir, { recursive: true, force: true });
    }
  });
});
