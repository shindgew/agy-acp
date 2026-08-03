import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import { client as acpClient, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { createAcpApp, createAcpV2App } from "../src/agent.js";
import { createConversationDb, insertStep } from "./fixtures/conversation-db.js";
import { encodeStepPayload } from "./fixtures/step-encoder.js";
import type { SpawnFactory } from "../src/agy/cli.js";

const TEST_MODELS_OUTPUT =
  "gemini-3.5-flash-medium\ngemini-3.5-flash-high\nclaude-opus-4-6-thinking\nclaude-sonnet-4-6\n";

function printModeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { AGY_ACP_MODEL_CACHE: "0", ...overrides, AGY_ACP_INTERACTIVE_PERMISSIONS: "0" };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function withConversationsDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-test-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

function spawnAgyWritingConversation(
  dir: string,
  conversationId: string,
  steps: Parameters<typeof insertStep>[1][]
): SpawnFactory {
  return ((command: string, args: string[]) => {
    if (args[0] === "models") {
      return new FakeProcess([TEST_MODELS_OUTPUT]);
    }
    const db = createConversationDb(dir, conversationId);
    for (const step of steps) insertStep(db, step);
    db.close();
    return new FakeProcess([]);
  }) as unknown as SpawnFactory;
}

class ControlledFakeProcess extends EventEmitter {
  stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  exitCode: number | null = null;
  pid = 1;

  finish(code = 0) {
    this.exitCode = code;
    this.stdout.push(null);
    this.stderr.push(null);
    this.emit("exit", code, null);
  }

  kill(signal?: string) {
    this.exitCode = signal === "SIGKILL" ? -9 : -15;
    this.stdout.push(null);
    this.stderr.push(null);
    this.emit("exit", this.exitCode, signal ?? "SIGTERM");
    return true;
  }
}

describe("queue and steer-by-cancel", () => {
  it("rejects overlapping prompts when no turnIntent meta is provided", async () => {
    await withConversationsDir(async (dir) => {
      let activeProc: ControlledFakeProcess | null = null;
      let promptCount = 0;
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        promptCount++;
        const convId = `conv-${promptCount}`;
        const db = createConversationDb(dir, convId);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt" }) });
        insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "reply" }) });
        db.close();
        const proc = new ControlledFakeProcess();
        activeProc = proc;
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          env: printModeEnv({ AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        // Start first prompt (which stays active)
        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });

        await waitFor(() => activeProc !== null);

        // Overlapping prompt without turnIntent should reject immediately
        await expect(
          connection.agent.request(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "prompt 2" }]
          })
        ).rejects.toThrow();

        (activeProc as ControlledFakeProcess | null)?.finish();
        await p1;
      } finally {
        connection.close();
      }
    });
  });

  it("queues v1 follow-up prompts and executes them in FIFO order", async () => {
    await withConversationsDir(async (dir) => {
      const executedPrompts: string[] = [];
      const processes: ControlledFakeProcess[] = [];
      let promptCount = 0;
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const promptIdx = args.indexOf("--print");
        const promptText = promptIdx >= 0 ? args[promptIdx + 1] : "";
        executedPrompts.push(promptText);

        promptCount++;
        const convId = `conv-${promptCount}`;
        const db = createConversationDb(dir, convId);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: promptText }) });
        insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: `ans ${promptText}` }) });
        db.close();

        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          env: printModeEnv({ AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        // First prompt
        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });

        await waitFor(() => processes.length === 1);

        // Second prompt queued
        const p2 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 2" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any);

        // Third prompt queued
        const p3 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 3" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any);

        // Finish prompt 1
        processes[0].finish();
        const r1 = await p1;

        // Prompt 2 should now be running
        await waitFor(() => processes.length === 2);
        processes[1].finish();
        const r2 = (await p2) as acp.PromptResponse;

        // Prompt 3 should now be running
        await waitFor(() => processes.length === 3);
        processes[2].finish();
        const r3 = (await p3) as acp.PromptResponse;

        expect(r1.stopReason).toBe("end_turn");
        expect(r2.stopReason).toBe("end_turn");
        expect(r3.stopReason).toBe("end_turn");

        expect(executedPrompts).toEqual(["prompt 1", "prompt 2", "prompt 3"]);
      } finally {
        connection.close();
      }
    });
  });

  it("queues v2 follow-up prompts, returning {} immediately and ordering updates", async () => {
    await withConversationsDir(async (dir) => {
      const updates: Array<Record<string, unknown>> = [];
      const client = acpV2.client({ name: "test-client" }).onNotification(
        acpV2.methods.client.session.update,
        (ctx) => {
          updates.push(ctx.params.update as Record<string, unknown>);
        }
      );
      const connection = client.connect(
        createAcpV2App({
          env: printModeEnv({ AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir }),
          spawnProcess: spawnAgyWritingConversation(dir, "conv-v2-queue", [
            { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt 1" }) },
            { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "ans 1" }) },
            { idx: 2, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt 2" }) },
            { idx: 3, stepType: 15, stepPayload: encodeStepPayload({ agentText: "ans 2" }) }
          ])
        })
      );
      try {
        await connection.agent.request(acpV2.methods.agent.initialize, {
          protocolVersion: 2,
          info: { name: "test-client", version: "0.0.0" },
          capabilities: {}
        });
        const session = await connection.agent.request(acpV2.methods.agent.session.new, {
          cwd: "/repo"
        });

        // Prompt 1
        const r1 = await connection.agent.request(acpV2.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });
        expect(r1).toEqual({});

        // Prompt 2 queued while 1 is active
        const r2 = await connection.agent.request(acpV2.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 2" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any);
        expect(r2).toEqual({});

        await waitFor(() => {
          const idleCount = updates.filter((u) => u.sessionUpdate === "state_update" && u.state === "idle").length;
          return idleCount >= 2;
        });

        const userMessages = updates.filter((u) => u.sessionUpdate === "user_message");
        expect(userMessages.length).toBe(2);

        const states = updates.filter((u) => u.sessionUpdate === "state_update");
        // State updates: running (p1) -> idle (p1) -> running (p2) -> idle (p2)
        expect(states.map((s) => ({ state: s.state, stopReason: s.stopReason }))).toEqual([
          { state: "running", stopReason: undefined },
          { state: "idle", stopReason: "end_turn" },
          { state: "running", stopReason: undefined },
          { state: "idle", stopReason: "end_turn" }
        ]);
      } finally {
        connection.close();
      }
    });
  });

  it("steers an active turn by cancelling it and executing the steer prompt", async () => {
    await withConversationsDir(async (dir) => {
      const executedPrompts: string[] = [];
      const processes: ControlledFakeProcess[] = [];
      let promptCount = 0;
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const promptIdx = args.indexOf("--print");
        const promptText = promptIdx >= 0 ? args[promptIdx + 1] : "";
        executedPrompts.push(promptText);

        promptCount++;
        const convId = `conv-steer-${promptCount}`;
        const db = createConversationDb(dir, convId);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: promptText }) });
        insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: `ans ${promptText}` }) });
        db.close();

        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          env: printModeEnv({ AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        // Start long-running prompt 1
        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "long running turn" }]
        });

        await waitFor(() => processes.length === 1);

        // Steer with prompt 2
        const p2 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "steer turn" }],
          _meta: { "agy-acp/turnIntent": "steer" }
        } as any);

        // Turn 1 should be cancelled via SIGINT kill
        const r1 = await p1;
        expect(r1.stopReason).toBe("cancelled");

        // Complete steer process
        await waitFor(() => processes.length === 2);
        processes[1].finish();

        const r2 = (await p2) as acp.PromptResponse;
        expect(r2.stopReason).toBe("end_turn");

        expect(executedPrompts).toEqual(["long running turn", "steer turn"]);
      } finally {
        connection.close();
      }
    });
  });

  it("serializes competing steer requests", async () => {
    await withConversationsDir(async (dir) => {
      const processes: ControlledFakeProcess[] = [];
      const executedPrompts: string[] = [];
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const promptIdx = args.indexOf("--print");
        executedPrompts.push(promptIdx >= 0 ? args[promptIdx + 1] : "");
        const db = createConversationDb(dir, `conv-steer-serial-${processes.length}`);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt" }) });
        db.close();
        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          env: printModeEnv({ AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });
        await waitFor(() => processes.length === 1);

        const p2 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "steer 1" }],
          _meta: { "agy-acp/turnIntent": "steer" }
        } as any);
        const p3 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "steer 2" }],
          _meta: { "agy-acp/turnIntent": "steer" }
        } as any);

        await waitFor(() => processes.length === 2);
        expect(executedPrompts).toEqual(["prompt 1", "steer 1"]);
        processes[1].finish();
        await p1;
        await p2;

        await waitFor(() => processes.length === 3);
        expect(executedPrompts).toEqual(["prompt 1", "steer 1", "steer 2"]);
        processes[2].finish();
        await p3;
      } finally {
        connection.close();
      }
    });
  });

  // The ACP SDK request helper does not currently expose a request-abort
  // option, so queued request cancellation is covered by session close below.
  it.skip("cancels a specific queued prompt via signal abort", async () => {
    await withConversationsDir(async (dir) => {
      const processes: ControlledFakeProcess[] = [];
      const executedPrompts: string[] = [];
      let promptCount = 0;
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const promptIdx = args.indexOf("--print");
        const promptText = promptIdx >= 0 ? args[promptIdx + 1] : "";
        executedPrompts.push(promptText);

        promptCount++;
        const convId = `conv-abort-${promptCount}`;
        const db = createConversationDb(dir, convId);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: promptText }) });
        insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: `ans ${promptText}` }) });
        db.close();

        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          env: printModeEnv({ AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });

        await waitFor(() => processes.length === 1);

        // Queue item 2 with AbortController
        const controller = new AbortController();
        const p2 = (connection.agent.request as any)(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 2" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any, { signal: controller.signal });

        // Abort p2 while p1 is active
        controller.abort();

        const r2 = (await p2) as acp.PromptResponse;
        expect(r2.stopReason).toBe("cancelled");

        // Complete p1
        processes[0].finish();
        const r1 = await p1;
        expect(r1.stopReason).toBe("end_turn");

        // Only prompt 1 was executed
        expect(executedPrompts).toEqual(["prompt 1"]);
      } finally {
        connection.close();
      }
    });
  });

  it("drains and cancels queued prompts on session close", async () => {
    await withConversationsDir(async (dir) => {
      const processes: ControlledFakeProcess[] = [];
      let promptCount = 0;
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        promptCount++;
        const convId = `conv-close-${promptCount}`;
        const db = createConversationDb(dir, convId);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt" }) });
        db.close();

        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          env: printModeEnv({ AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });

        await waitFor(() => processes.length === 1);

        const p2 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 2" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any);

        // Close session while p1 is active and p2 is queued
        await connection.agent.request(methods.agent.session.close, {
          sessionId: session.sessionId
        });

        const r1 = await p1;
        const r2 = (await p2) as acp.PromptResponse;

        expect(r1.stopReason).toBe("cancelled");
        expect(r2.stopReason).toBe("cancelled");
      } finally {
        connection.close();
      }
    });
  });

  it("continues draining the queue if an active turn fails with an error", async () => {
    await withConversationsDir(async (dir) => {
      const executedPrompts: string[] = [];
      let promptCount = 0;
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const promptIdx = args.indexOf("--print");
        const promptText = promptIdx >= 0 ? args[promptIdx + 1] : "";
        executedPrompts.push(promptText);

        promptCount++;
        const convId = `conv-fail-${promptCount}`;
        const db = createConversationDb(dir, convId);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: promptText }) });
        insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: `ans ${promptText}` }) });
        db.close();

        if (promptText === "failing prompt") {
          return new FakeProcess([], { exitCode: 1, stderr: "error" });
        }
        const proc = new ControlledFakeProcess();
        queueMicrotask(() => proc.finish(0));
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          env: printModeEnv({ AGY_ACP_CONVERSATIONS_DIR: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "failing prompt" }]
        });

        const p2 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "queued after failure" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any);

        await expect(p1).rejects.toThrow();

        const r2 = (await p2) as acp.PromptResponse;
        expect(r2.stopReason).toBe("end_turn");
        expect(executedPrompts).toEqual(["failing prompt", "queued after failure"]);
      } finally {
        connection.close();
      }
    });
  });
});
