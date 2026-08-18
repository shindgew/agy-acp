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
import { discardForkedConversation, forkConversation } from "../src/agy/db/fork.js";
import { forkSession, persistSession, reloadSession } from "../src/acp/session/setup.js";
import { SessionStore } from "../src/acp/session/store.js";
import { KeyedAsyncLock } from "../src/acp/session/setup-lock.js";
import type { AgyCliBackend } from "../src/agy/cli.js";
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
      const forked = await forkConversation(convDir, srcId, targetId, brainDir);
      expect(forked.maxStepIdx).toBe(1);

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

  it("rejects fork and discards dest db when cascade_id cannot be rebound", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-test-"));
    const convDir = path.join(tmpDir, "conversations");
    fs.mkdirSync(convDir, { recursive: true });

    try {
      const srcId = "src-bad-meta";
      const targetId = "target-bad-meta";
      const srcDb = createConversationDb(convDir, srcId);
      srcDb.exec(`
        CREATE TABLE trajectory_meta (foo text);
        INSERT INTO trajectory_meta VALUES ('x');
      `);
      insertStep(srcDb, {
        idx: 0,
        stepType: 1,
        status: 3,
        stepPayload: encodeStepPayload({ userPrompt: "prompt" })
      });
      srcDb.close();

      await expect(forkConversation(convDir, srcId, targetId)).rejects.toThrow(
        /Failed to rebind forked conversation database/
      );
      expect(fs.existsSync(path.join(convDir, `${targetId}.db`))).toBe(false);
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

  it("rejects fork and discards dest db when brain artifact copy fails", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-brain-fail-"));
    const convDir = path.join(tmpDir, "conversations");
    const brainDir = path.join(tmpDir, "brain");
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(brainDir, { recursive: true });

    try {
      const srcId = "src-brain-fail";
      const targetId = "target-brain-fail";
      const srcDb = createConversationDb(convDir, srcId);
      insertStep(srcDb, {
        idx: 0,
        stepType: 1,
        status: 3,
        stepPayload: encodeStepPayload({ userPrompt: "prompt" })
      });
      srcDb.close();
      fs.mkdirSync(path.join(brainDir, srcId), { recursive: true });
      fs.writeFileSync(path.join(brainDir, srcId, "plan.md"), "# plan");
      fs.writeFileSync(path.join(brainDir, targetId), "not-a-directory");

      await expect(forkConversation(convDir, srcId, targetId, brainDir)).rejects.toThrow(
        /Failed to copy brain artifacts/
      );
      expect(fs.existsSync(path.join(convDir, `${targetId}.db`))).toBe(false);
      expect(fs.existsSync(path.join(brainDir, targetId))).toBe(false);
      expect(fs.existsSync(path.join(brainDir, srcId, "plan.md"))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("discardForkedConversation removes dest db and brain artifacts", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-test-"));
    const convDir = path.join(tmpDir, "conversations");
    const brainDir = path.join(tmpDir, "brain");
    fs.mkdirSync(path.join(brainDir, "child-id"), { recursive: true });
    fs.writeFileSync(path.join(brainDir, "child-id", "plan.md"), "x");
    createConversationDb(convDir, "child-id").close();
    try {
      discardForkedConversation(convDir, "child-id", brainDir);
      expect(fs.existsSync(path.join(convDir, "child-id.db"))).toBe(false);
      expect(fs.existsSync(path.join(brainDir, "child-id"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("forkSession artifact cleanup", () => {
  it("discards copied conversation artifacts if child setup fails after snapshot", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-cleanup-"));
    const convDir = path.join(tmpDir, "conversations");
    const brainDir = path.join(tmpDir, "brain");
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(brainDir, { recursive: true });

    const srcId = "src-cleanup";
    const srcDb = createConversationDb(convDir, srcId);
    insertStep(srcDb, {
      idx: 0,
      stepType: 1,
      status: 3,
      stepPayload: encodeStepPayload({ userPrompt: "prompt" })
    });
    srcDb.close();
    fs.mkdirSync(path.join(brainDir, srcId), { recursive: true });
    fs.writeFileSync(path.join(brainDir, srcId, "plan.md"), "# plan");

    const parentId = "parent-cleanup";
    const store = new SessionStore(stateDir);
    await store.persist(parentId, {
      cwd: "/workspace",
      additionalDirectories: [],
      conversationId: srcId,
      lastStepIdx: 0,
      model: "gemini-2.5-flash",
      reasoningEffort: "",
      v2UserMessageIdsByStep: {},
      updatedAt: new Date().toISOString()
    });

    try {
      await expect(
        forkSession(parentId, "/workspace", [], {
          env: process.env,
          argv: ["--no-interactive-permissions"],
          backend: { startSession: async () => {
            throw new Error("start failed");
          } } as unknown as AgyCliBackend,
          getModelOptions: async () => {
            throw new Error("catalog failed");
          },
          conversationsDir: convDir,
          store,
          sessions: new Map(),
          maxActiveSessions: 8,
          persistSession: async () => {},
          setupLocks: new KeyedAsyncLock()
        })
      ).rejects.toThrow("catalog failed");

      const leftoverDbs = fs.readdirSync(convDir).filter((name) => name.endsWith(".db"));
      expect(leftoverDbs).toEqual([`${srcId}.db`]);
      expect(fs.readdirSync(brainDir)).toEqual([srcId]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rolls back registered child session and cleans up artifacts if persistSession fails", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-persist-fail-"));
    const convDir = path.join(tmpDir, "conversations");
    const brainDir = path.join(tmpDir, "brain");
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(brainDir, { recursive: true });

    const srcId = "src-persist-fail";
    const srcDb = createConversationDb(convDir, srcId);
    insertStep(srcDb, {
      idx: 0,
      stepType: 1,
      status: 3,
      stepPayload: encodeStepPayload({ userPrompt: "prompt" })
    });
    srcDb.close();
    fs.mkdirSync(path.join(brainDir, srcId), { recursive: true });
    fs.writeFileSync(path.join(brainDir, srcId, "plan.md"), "# plan");

    const parentId = "parent-persist-fail";
    const store = new SessionStore(stateDir);
    await store.persist(parentId, {
      cwd: "/workspace",
      additionalDirectories: [],
      conversationId: srcId,
      lastStepIdx: 0,
      model: "gemini-2.5-flash",
      reasoningEffort: "",
      v2UserMessageIdsByStep: {},
      updatedAt: new Date().toISOString()
    });

    const activeSessions = new Map();
    try {
      await expect(
        forkSession(parentId, "/workspace", [], {
          env: process.env,
          argv: ["--no-interactive-permissions"],
          backend: {
            startSession: async () => ({
              restoreConversation: () => {},
              setModel: () => {},
              setEffort: () => {},
              setMode: () => {},
              close: async () => {}
            })
          } as unknown as AgyCliBackend,
          getModelOptions: async () => ["gemini-2.5-flash"],
          conversationsDir: convDir,
          store,
          sessions: activeSessions,
          maxActiveSessions: 8,
          persistSession: async () => {
            throw new Error("disk full on persist");
          },
          setupLocks: new KeyedAsyncLock()
        })
      ).rejects.toThrow("disk full on persist");

      // Child session must not remain in the active sessions map
      expect(activeSessions.size).toBe(0);

      // Copied conversation db and brain directory must be removed
      const leftoverDbs = fs.readdirSync(convDir).filter((name) => name.endsWith(".db"));
      expect(leftoverDbs).toEqual([`${srcId}.db`]);
      expect(fs.readdirSync(brainDir)).toEqual([srcId]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rolls back a fork when SessionStore.persist cannot write the state directory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-store-unwritable-"));
    const convDir = path.join(tmpDir, "conversations");
    const brainDir = path.join(tmpDir, "brain");
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(brainDir, { recursive: true });

    const srcId = "src-unwritable";
    const srcDb = createConversationDb(convDir, srcId);
    insertStep(srcDb, {
      idx: 0,
      stepType: 1,
      status: 3,
      stepPayload: encodeStepPayload({ userPrompt: "prompt" })
    });
    srcDb.close();
    fs.mkdirSync(path.join(brainDir, srcId), { recursive: true });
    fs.writeFileSync(path.join(brainDir, srcId, "plan.md"), "# plan");

    const parentId = "parent-unwritable";
    const store = new SessionStore(stateDir);
    await store.persist(parentId, {
      cwd: "/workspace",
      additionalDirectories: [],
      conversationId: srcId,
      lastStepIdx: 0,
      model: "gemini-2.5-flash",
      reasoningEffort: "",
      v2UserMessageIdsByStep: {},
      updatedAt: new Date().toISOString()
    });

    const activeSessions = new Map();
    fs.chmodSync(stateDir, 0o555);
    try {
      await expect(
        forkSession(parentId, "/workspace", [], {
          env: process.env,
          argv: ["--no-interactive-permissions"],
          backend: {
            startSession: async () => ({
              restoreConversation: () => {},
              setModel: () => {},
              setEffort: () => {},
              setMode: () => {},
              close: async () => {}
            })
          } as unknown as AgyCliBackend,
          getModelOptions: async () => ["gemini-2.5-flash"],
          conversationsDir: convDir,
          store,
          sessions: activeSessions,
          maxActiveSessions: 8,
          persistSession: (sessionId, session) => persistSession(store, sessionId, session),
          setupLocks: new KeyedAsyncLock()
        })
      ).rejects.toThrow();

      expect(activeSessions.size).toBe(0);
      const leftoverDbs = fs.readdirSync(convDir).filter((name) => name.endsWith(".db"));
      expect(leftoverDbs).toEqual([`${srcId}.db`]);
      expect(fs.readdirSync(brainDir)).toEqual([srcId]);
    } finally {
      try { fs.chmodSync(stateDir, 0o755); } catch {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("evicts the claimed parent when forking at the active-session cap", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-cap-"));
    const convDir = path.join(tmpDir, "conversations");
    const brainDir = path.join(tmpDir, "brain");
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(brainDir, { recursive: true });

    const srcId = "src-cap";
    const srcDb = createConversationDb(convDir, srcId);
    insertStep(srcDb, {
      idx: 0,
      stepType: 1,
      status: 3,
      stepPayload: encodeStepPayload({ userPrompt: "prompt" })
    });
    srcDb.close();

    const parentId = "parent-cap";
    const store = new SessionStore(stateDir);
    await store.persist(parentId, {
      cwd: "/workspace",
      additionalDirectories: [],
      conversationId: srcId,
      lastStepIdx: 0,
      model: "gemini-2.5-flash",
      reasoningEffort: "",
      v2UserMessageIdsByStep: {},
      updatedAt: new Date().toISOString()
    });

    const closed: string[] = [];
    const backend = {
      startSession: async () => ({
        conversationId: srcId,
        lastStepIdx: 0,
        config: { mode: "default" },
        restoreConversation: () => {},
        setModel: () => {},
        setEffort: () => {},
        setMode: () => {},
        close: async () => {
          closed.push("closed");
        }
      })
    } as unknown as AgyCliBackend;

    const activeSessions = new Map();
    const { session: parentSession } = await reloadSession(parentId, "/workspace", [], {
      env: process.env,
      argv: ["--no-interactive-permissions"],
      backend,
      getModelOptions: async () => ["gemini-2.5-flash"],
      conversationsDir: convDir,
      store,
      sessions: activeSessions,
      maxActiveSessions: 1,
      setupLocks: new KeyedAsyncLock()
    });

    try {
      const forked = await forkSession(parentId, "/workspace", [], {
        env: process.env,
        argv: ["--no-interactive-permissions"],
        backend,
        getModelOptions: async () => ["gemini-2.5-flash"],
        conversationsDir: convDir,
        store,
        sessions: activeSessions,
        maxActiveSessions: 1,
        persistSession: async () => {},
        setupLocks: new KeyedAsyncLock()
      });

      expect(activeSessions.size).toBe(1);
      expect(activeSessions.has(parentId)).toBe(false);
      expect(activeSessions.get(forked.childSessionId)).toBe(forked.childSession);
      expect(parentSession.closed).toBe(true);
      expect(closed.length).toBeGreaterThan(0);
    } finally {
      for (const session of activeSessions.values()) {
        session.closed = true;
        await session.agy.close().catch(() => {});
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("KeyedAsyncLock", () => {
  it("runs same-key callbacks one at a time and leaves other keys concurrent", async () => {
    const lock = new KeyedAsyncLock();
    const order: string[] = [];
    let releaseA: (() => void) | undefined;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const a = lock.run("same", async () => {
      order.push("a-start");
      await aGate;
      order.push("a-end");
      return "a";
    });
    const b = lock.run("same", async () => {
      order.push("b");
      return "b";
    });
    const other = lock.run("other", async () => {
      order.push("other");
      return "other";
    });

    await vi.waitFor(() => {
      expect(order).toContain("a-start");
      expect(order).toContain("other");
    });
    expect(order).not.toContain("b");

    releaseA!();
    await expect(Promise.all([a, b, other])).resolves.toEqual(["a", "b", "other"]);
    expect(order.indexOf("b")).toBeGreaterThan(order.indexOf("a-end"));
    expect(order).toContain("other");
  });

  it("still runs the next waiter after a rejected holder", async () => {
    const lock = new KeyedAsyncLock();
    const first = lock.run("k", async () => {
      throw new Error("holder failed");
    });
    const second = lock.run("k", async () => "ok");
    await expect(first).rejects.toThrow("holder failed");
    await expect(second).resolves.toBe("ok");
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
      const forkedSteps = forkedDb.prepare("SELECT idx, step_type FROM steps ORDER BY idx").all() as Array<{
        idx: number;
      }>;
      expect(forkedSteps).toHaveLength(2);
      const snapshotMaxIdx = Math.max(...forkedSteps.map((step) => step.idx));
      expect(storeAfterFork.sessions[forked.sessionId].lastStepIdx).toBe(snapshotMaxIdx);
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

  it("rejects session replacement while turn or fork claim is active", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue("/opt/homebrew/bin/agy");
    const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-v1-replace-"));

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

      const session = await connection.agent.request(methods.agent.session.new, {
        cwd: "/parent/workspace",
        mcpServers: []
      });
      await flushDeferredNotifications();

      // Start prompt turn to make session busy
      const promptPromise = connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "run slow task" }]
      });

      // Attempt to load/resume and replace the busy session
      await expect(
        connection.agent.request(methods.agent.session.load, {
          sessionId: session.sessionId,
          cwd: "/parent/workspace",
          mcpServers: []
        })
      ).rejects.toThrow();

      // Clean up hanging turn
      hangingProcess.emit("exit", 0, null);
      await promptPromise.catch(() => {});
    } finally {
      installSpy.mockRestore();
      connection.close();
      fs.rmSync(tmpStateDir, { recursive: true, force: true });
    }
  });

  it("forks a persisted parent that is no longer in the active-session map", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue("/opt/homebrew/bin/agy");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-v1-cold-"));
    const convDir = path.join(tmpDir, "conversations");
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    const parentConvId = "cold-parent-conv";
    const spawnProcess = spawnAgyWritingConversation(convDir, parentConvId, [
      { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "cold parent" }) }
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

      const parent = await connection.agent.request(methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: []
      });
      await flushDeferredNotifications();
      await connection.agent.request(methods.agent.session.prompt, {
        sessionId: parent.sessionId,
        prompt: [{ type: "text", text: "seed history" }]
      });

      await connection.agent.request(methods.agent.session.close, {
        sessionId: parent.sessionId
      });

      const forked = (await connection.agent.request(methods.agent.session.fork, {
        sessionId: parent.sessionId,
        cwd: "/workspace"
      })) as V1ForkSessionResponse;
      expect(forked.sessionId).not.toBe(parent.sessionId);

      const storeAfterFork = JSON.parse(fs.readFileSync(path.join(stateDir, "sessions.json"), "utf-8"));
      const forkedConvId = storeAfterFork.sessions[forked.sessionId].conversationId;
      expect(forkedConvId).toBeDefined();
      expect(forkedConvId).not.toBe(parentConvId);
      expect(storeAfterFork.sessions[forked.sessionId].lastStepIdx).toBe(1);
    } finally {
      installSpy.mockRestore();
      connection.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("binds the child cursor to the copied db when the stored parent cursor is stale", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue("/opt/homebrew/bin/agy");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-v1-stale-"));
    const convDir = path.join(tmpDir, "conversations");
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    const parentConvId = "stale-parent-conv";
    const spawnProcess = spawnAgyWritingConversation(convDir, parentConvId, [
      { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "one" }) },
      { idx: 2, stepType: 15, stepPayload: encodeStepPayload({ agentText: "two" }) }
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

      const parent = await connection.agent.request(methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: []
      });
      await flushDeferredNotifications();
      await connection.agent.request(methods.agent.session.prompt, {
        sessionId: parent.sessionId,
        prompt: [{ type: "text", text: "seed history" }]
      });
      await connection.agent.request(methods.agent.session.close, {
        sessionId: parent.sessionId
      });

      const storePath = path.join(stateDir, "sessions.json");
      const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      store.sessions[parent.sessionId].lastStepIdx = 0;
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

      const forked = (await connection.agent.request(methods.agent.session.fork, {
        sessionId: parent.sessionId,
        cwd: "/workspace"
      })) as V1ForkSessionResponse;

      const storeAfterFork = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      expect(storeAfterFork.sessions[forked.sessionId].lastStepIdx).toBe(2);
    } finally {
      installSpy.mockRestore();
      connection.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("serializes fork of a persisted parent against a concurrent resume", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue("/opt/homebrew/bin/agy");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fork-v1-lock-"));
    const convDir = path.join(tmpDir, "conversations");
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    const parentConvId = "locked-parent-conv";
    const spawnProcess = spawnAgyWritingConversation(convDir, parentConvId, [
      { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "locked" }) }
    ]);

    const agent = new AcpAgent({
      stateDir,
      conversationsDir: convDir,
      argv: ["--no-interactive-permissions"],
      spawnProcess
    });
    const connection = acpClient({ name: "test-client" }).connect(createAcpApp(agent));

    let releaseRestore: (() => void) | undefined;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let restoreCalls = 0;
    const originalRestore = SessionStore.prototype.restore;
    let restoreSpy: ReturnType<typeof vi.spyOn> | undefined;

    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {}
      });

      const parent = await connection.agent.request(methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: []
      });
      await flushDeferredNotifications();
      await connection.agent.request(methods.agent.session.prompt, {
        sessionId: parent.sessionId,
        prompt: [{ type: "text", text: "seed history" }]
      });
      await connection.agent.request(methods.agent.session.close, {
        sessionId: parent.sessionId
      });

      restoreSpy = vi.spyOn(SessionStore.prototype, "restore").mockImplementation(async function (
        this: SessionStore,
        sessionId: string
      ) {
        restoreCalls += 1;
        if (restoreCalls === 1) await restoreGate;
        return originalRestore.call(this, sessionId);
      });

      const forkPromise = connection.agent.request(methods.agent.session.fork, {
        sessionId: parent.sessionId,
        cwd: "/workspace"
      });
      await vi.waitFor(() => {
        expect(restoreCalls).toBeGreaterThan(0);
      });

      let resumeSettled = false;
      const resumePromise = connection.agent.request(methods.agent.session.resume, {
        sessionId: parent.sessionId,
        cwd: "/workspace",
        mcpServers: []
      }).then((result) => {
        resumeSettled = true;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(resumeSettled).toBe(false);
      expect(restoreCalls).toBe(1);

      releaseRestore!();
      const forked = (await forkPromise) as V1ForkSessionResponse;
      await resumePromise;
      expect(forked.sessionId).not.toBe(parent.sessionId);
      expect(resumeSettled).toBe(true);
    } finally {
      restoreSpy?.mockRestore();
      installSpy.mockRestore();
      connection.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
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
