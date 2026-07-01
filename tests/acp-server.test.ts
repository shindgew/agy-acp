import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import * as installer from "../src/agy-installer.js";
import { client as acpClient, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
  buildModelCatalog,
  createAgyAcpApp,
  modelConfigOption,
  promptBlocksToText,
  reasoningEffectConfigOption
} from "../src/acp-server.js";
import type { SpawnFactory } from "../src/agy-cli.js";
import { createConversationDb, insertStep } from "./fixtures/conversation-db.js";
import { encodeStepPayload, encodeToolCall, encodeToolRun } from "./fixtures/step-encoder.js";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";

type SelectConfigOption = Extract<SessionConfigOption, { type: "select" }>;

describe("promptBlocksToText", () => {
  it("joins text content blocks", () => {
    expect(promptBlocksToText([
      { type: "text", text: "first" },
      { type: "text", text: "second" }
    ])).toBe("first\nsecond");
  });
});

describe("initialize", () => {
  it("returns SDK-validated ACP capabilities", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const connection = acpClient({ name: "test-client" }).connect(createAgyAcpApp());
    try {
      const response = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {}
      });

      expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(response.agentInfo?.name).toBe("agy-acp");
      expect(response.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true);
      expect(response.agentCapabilities?.promptCapabilities?.image).toBe(true);
      expect(response.agentCapabilities?.sessionCapabilities?.additionalDirectories).toEqual({});
      expect(installSpy).toHaveBeenCalledOnce();
    } finally {
      installSpy.mockRestore();
      connection.close();
    }
  });
});

describe("session prompt", () => {
  it("streams agy's conversation database as ACP message chunks", async () => {
    await withConversationsDir(async (dir) => {
      const updates: unknown[] = [];
      const client = acpClient({ name: "test-client" })
        .onNotification(methods.client.session.update, (ctx) => {
          updates.push(ctx.params.update);
        });
      const connection = client.connect(createAgyAcpApp({
        env: { AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir },
        spawnProcess: spawnAgyWritingConversation(dir, "conv-1", [
          { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "hello" }) }
        ])
      }));
      try {
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          additionalDirectories: [],
          mcpServers: []
        });
        const response = await connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hi" }]
        });

        expect(updates[0]).toMatchObject({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" }
        });
        expect(response.stopReason).toBe("end_turn");
      } finally {
        connection.close();
      }
    });
  });

  it("renders a structured tool-run step as an ACP tool_call", async () => {
    await withConversationsDir(async (dir) => {
      const updates: unknown[] = [];
      const client = acpClient({ name: "test-client" })
        .onNotification(methods.client.session.update, (ctx) => {
          updates.push(ctx.params.update);
        });
      const connection = client.connect(createAgyAcpApp({
        env: { AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir },
        spawnProcess: spawnAgyWritingConversation(dir, "conv-2", [
          {
            idx: 1,
            stepType: 21,
            stepPayload: encodeStepPayload({
              toolRun: encodeToolRun({
                call: encodeToolCall({ namePrimary: "run_command", rawInputJson: '{"CommandLine":"echo hi"}' })
              })
            })
          },
          { idx: 2, stepType: 15, stepPayload: encodeStepPayload({ agentText: "done" }) }
        ])
      }));
      try {
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          additionalDirectories: [],
          mcpServers: []
        });
        const response = await connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hi" }]
        });

        expect(updates).toMatchObject([
          {
            sessionUpdate: "tool_call",
            kind: "execute",
            title: "echo hi",
            status: "completed"
          },
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "done" }
          }
        ]);
        expect(response.stopReason).toBe("end_turn");
      } finally {
        connection.close();
      }
    });
  });
});

describe("session/load and session/resume", () => {
  it("replays prior conversation history on load, but not on resume, after a simulated restart", async () => {
    await withConversationsDir(async (dir) => {
      const appOptions = {
        env: { AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir },
        spawnProcess: spawnAgyWritingConversation(dir, "conv-persisted", [
          { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "hello from before" }) }
        ])
      };

      // First "process": create a session, run a prompt, then disconnect —
      // simulating the ACP client reconnecting to a fresh server instance.
      let sessionId: string;
      {
        const connection = acpClient({ name: "test-client" }).connect(createAgyAcpApp(appOptions));
        try {
          const session = await connection.agent.request(methods.agent.session.new, {
            cwd: "/repo",
            additionalDirectories: [],
            mcpServers: []
          });
          sessionId = session.sessionId;
          await connection.agent.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "hi" }]
          });
        } finally {
          connection.close();
        }
      }

      // session/load: a brand-new AgyAcpAgent (no in-memory state) should
      // restore the binding from disk and replay the prior turn.
      {
        const updates: unknown[] = [];
        const client = acpClient({ name: "test-client" })
          .onNotification(methods.client.session.update, (ctx) => {
            updates.push(ctx.params.update);
          });
        const connection = client.connect(createAgyAcpApp(appOptions));
        try {
          const response = await connection.agent.request(methods.agent.session.load, {
            sessionId,
            cwd: "/repo",
            mcpServers: []
          });
          expect(updates).toContainEqual(
            expect.objectContaining({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hello from before" }
            })
          );
          expect(response.configOptions?.length).toBeGreaterThan(0);
        } finally {
          connection.close();
        }
      }

      // session/resume: same restoration, but no history replay.
      {
        const updates: unknown[] = [];
        const client = acpClient({ name: "test-client" })
          .onNotification(methods.client.session.update, (ctx) => {
            updates.push(ctx.params.update);
          });
        const connection = client.connect(createAgyAcpApp(appOptions));
        try {
          const response = await connection.agent.request(methods.agent.session.resume, {
            sessionId,
            cwd: "/repo"
          });
          expect(updates).toEqual([]);
          expect(response.configOptions?.length).toBeGreaterThan(0);
        } finally {
          connection.close();
        }
      }
    });
  });

  it("rejects loading a session that was never persisted", async () => {
    await withConversationsDir(async (dir) => {
      const connection = acpClient({ name: "test-client" }).connect(createAgyAcpApp({
        env: { AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir },
        spawnProcess: spawnAgyWritingConversation(dir, "unused", [])
      }));
      try {
        await expect(
          connection.agent.request(methods.agent.session.load, {
            sessionId: "does-not-exist",
            cwd: "/repo",
            mcpServers: []
          })
        ).rejects.toThrow();
      } finally {
        connection.close();
      }
    });
  });
});

describe("buildModelCatalog", () => {
  it("splits reasoning effects from base model names", () => {
    const catalog = buildModelCatalog([
      "Gemini 3.5 Flash (Medium)",
      "Gemini 3.5 Flash (High)",
      "Claude Sonnet 4.6 (Thinking)"
    ]);

    expect(catalog.baseModels()).toEqual([
      "Gemini 3.5 Flash",
      "Claude Sonnet 4.6 (Thinking)"
    ]);
    expect(catalog.effectsFor("Gemini 3.5 Flash")).toEqual(["Medium", "High"]);
    expect(catalog.effectsFor("Claude Sonnet 4.6 (Thinking)")).toEqual([]);
    expect(catalog.resolve("Gemini 3.5 Flash", "Medium")).toBe("Gemini 3.5 Flash (Medium)");
    expect(catalog.split("Gemini 3.5 Flash (High)")).toEqual({
      base: "Gemini 3.5 Flash",
      reasoningEffect: "High"
    });
  });

  it("keeps (Thinking) models intact instead of splitting them", () => {
    const catalog = buildModelCatalog([
      "Gemini 3.5 Flash (Medium)",
      "Claude Sonnet 4.6 (Thinking)",
      "Claude Sonnet 4.6 (Medium)"
    ]);

    expect(catalog.baseModels()).toEqual([
      "Gemini 3.5 Flash",
      "Claude Sonnet 4.6 (Thinking)",
      "Claude Sonnet 4.6"
    ]);
    expect(catalog.split("Claude Sonnet 4.6 (Thinking)")).toEqual({
      base: "Claude Sonnet 4.6 (Thinking)"
    });
    expect(catalog.effectsFor("Claude Sonnet 4.6 (Thinking)")).toEqual([]);
    const reasoningConfig = reasoningEffectConfigOption(
      "Claude Sonnet 4.6 (Thinking)",
      "__none__",
      catalog
    ) as SelectConfigOption;
    expect(reasoningConfig.options.map((option) => option.name)).toEqual(["N/A"]);
  });

  it("exposes separate model and reasoning effect config options", () => {
    const catalog = buildModelCatalog(["Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash (High)"]);
    const modelConfig = modelConfigOption("Gemini 3.5 Flash", catalog) as SelectConfigOption;
    const reasoningConfig = reasoningEffectConfigOption(
      "Gemini 3.5 Flash",
      "Medium",
      catalog
    ) as SelectConfigOption;

    expect(modelConfig.options.map((option) => option.name)).toEqual([
      "Gemini 3.5 Flash"
    ]);
    expect(reasoningConfig.options.map((option) => option.name)).toEqual(["Medium", "High"]);
  });
});

describe("session model config", () => {
  it("updates agy --model for later prompts", async () => {
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const spawnProcess = (command: string, args: string[], options: unknown) => {
      calls.push({ command, args, options });
      if (args[0] === "models") {
        return new FakeProcess(["Gemini 3.5 Flash (Medium)\nGemini 3.5 Flash (High)\nClaude Sonnet 4.6 (Thinking)\n"]);
      }
      return new FakeProcess(["ok"]);
    };
    const updates: Array<{ content: { text: string } }> = [];
    const client = acpClient({ name: "test-client" })
      .onNotification(methods.client.session.update, (ctx) => {
        updates.push(ctx.params.update as { content: { text: string } });
      });
    const connection = client.connect(createAgyAcpApp({ spawnProcess: spawnProcess as unknown as SpawnFactory }));
    try {
      const session = await connection.agent.request(methods.agent.session.new, {
        cwd: "/repo",
        additionalDirectories: [],
        mcpServers: []
      });
      const configOptions = session.configOptions ?? [];
      const modelConfig = configOptions.find((option) => option.id === "model") as SelectConfigOption | undefined;
      const reasoningConfig = configOptions.find((option) => option.id === "effort") as SelectConfigOption | undefined;
      const fastConfig = configOptions.find((option) => option.id === "fast-mode") as SelectConfigOption | undefined;

      expect(modelConfig?.category).toBe("model");
      expect(modelConfig?.currentValue).toBe("Gemini 3.5 Flash");
      expect(modelConfig?.options.map((option) => option.name)).toEqual([
        "Gemini 3.5 Flash",
        "Claude Sonnet 4.6 (Thinking)"
      ]);
      expect(optionValues(modelConfig!)).toEqual([
        "Gemini 3.5 Flash",
        "Claude Sonnet 4.6 (Thinking)"
      ]);
      expect(reasoningConfig?.category).toBe("thought_level");
      expect(reasoningConfig?.currentValue).toBe("Medium");
      expect(reasoningConfig?.options.map((option) => option.name)).toEqual(["Medium", "High"]);
      expect(fastConfig?.category).toBe("model_config");
      expect(fastConfig?.type).toBe("select");
      expect(fastConfig?.currentValue).toBe("off");

      const modelResponse = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "model",
        value: "Gemini 3.5 Flash"
      });
      expect(modelResponse.configOptions[0].currentValue).toBe("Gemini 3.5 Flash");
      expect(modelResponse.configOptions[1].currentValue).toBe("Medium");
      expect(optionValues(modelResponse.configOptions[1] as SelectConfigOption)).toEqual(["Medium", "High"]);

      const reasoningResponse = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "effort",
        value: "High"
      });
      expect(reasoningResponse.configOptions[1].currentValue).toBe("High");

      const fastResponse = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "fast-mode",
        value: "on"
      });
      expect(fastResponse.configOptions[2].currentValue).toBe("on");

      const thinkingResponse = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "model",
        value: "Claude Sonnet 4.6 (Thinking)"
      });
      expect(thinkingResponse.configOptions[0].currentValue).toBe("Claude Sonnet 4.6 (Thinking)");
      expect(thinkingResponse.configOptions[1].currentValue).toBe("__none__");
      expect(optionNames(thinkingResponse.configOptions[1] as SelectConfigOption)).toEqual(["N/A"]);

      await connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hi" }]
      });

      const promptCall = calls.find((call) => call.args.includes("--print"));
      expect(promptCall?.args[promptCall.args.indexOf("--print") + 1]).toBe("/fast\nhi");
      expect(flagValue(promptCall!.args, "--model")).toBe("Claude Sonnet 4.6 (Thinking)");
    } finally {
      connection.close();
    }
  });
});

const TEST_MODELS_OUTPUT = "Gemini 3.5 Flash (Medium)\nGemini 3.5 Flash (High)\nClaude Sonnet 4.6 (Thinking)\n";

/** Run `fn` with a throwaway conversations directory, cleaned up afterwards. */
async function withConversationsDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-test-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A spawn factory simulating agy: on `agy models` it returns the test model
 * list; on a real prompt turn it writes the given steps into a conversation
 * database (as agy itself would) before exiting, so the ACP server's poller
 * picks them up.
 */
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

class FakeProcess extends EventEmitter {
  stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  stdout: Readable;
  stderr = Readable.from([]);
  exitCode = 0;
  pid = 1;

  constructor(chunks: string[]) {
    super();
    this.stdout = Readable.from(chunks);
    queueMicrotask(() => this.emit("exit", 0, null));
  }

  kill() {
    this.exitCode = -15;
    this.emit("exit", -15, "SIGTERM");
    return true;
  }

  spawnFactory() {
    return () => this;
  }
}

function flagValue(command: string[], flag: string): string {
  return command[command.indexOf(flag) + 1];
}

function optionValues(configOption: SelectConfigOption): string[] {
  return configOption.options.map((option) => {
    if (!("value" in option)) {
      throw new Error("expected flat select options");
    }
    return option.value;
  });
}

function optionNames(configOption: SelectConfigOption): string[] {
  return configOption.options.map((option) => option.name);
}
