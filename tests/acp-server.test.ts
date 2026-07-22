import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import * as installer from "../src/installer.js";
import { client as acpClient, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import {
  buildModelCatalog,
  createAgyAcpApp,
  createAgyAcpV2App,
  modelConfigOption,
  promptBlocksToText,
  reasoningEffectConfigOption,
  toModelSlug
} from "../src/acp-server.js";
import type { SpawnFactory } from "../src/cli.js";
import { createConversationDb, insertStep } from "./fixtures/conversation-db.js";
import { encodeStepPayload, encodeToolCall, encodeToolRun } from "./fixtures/step-encoder.js";
import {
  expandSessionUpdateToV2,
  sessionUpdateToV2,
  terminalIdForToolCall
} from "../src/session-updates.js";
import type { SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk";

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
        env: printModeEnv({ AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir }),
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
        env: printModeEnv({ AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir }),
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
        env: printModeEnv({ AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir }),
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

  it("lists persisted sessions after a restart", async () => {
    await withConversationsDir(async (dir) => {
      const appOptions = {
        env: printModeEnv({ AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir }),
        spawnProcess: spawnAgyWritingConversation(dir, "conv-list", [
          { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "listed" }) }
        ])
      };

      let sessionId: string;
      {
        const connection = acpClient({ name: "test-client" }).connect(createAgyAcpApp(appOptions));
        try {
          const session = await connection.agent.request(methods.agent.session.new, {
            cwd: "/repo",
            additionalDirectories: ["/extra"],
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

      {
        const connection = acpClient({ name: "test-client" }).connect(createAgyAcpApp(appOptions));
        try {
          const listed = await connection.agent.request(methods.agent.session.list, {
            cwd: "/repo"
          });
          expect(listed.sessions).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                sessionId,
                cwd: "/repo",
                additionalDirectories: ["/extra"]
              })
            ])
          );
        } finally {
          connection.close();
        }
      }
    });
  });

  it("rejects loading a session that was never persisted", async () => {
    await withConversationsDir(async (dir) => {
      const connection = acpClient({ name: "test-client" }).connect(createAgyAcpApp({
        env: printModeEnv({ AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir }),
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

describe("toModelSlug", () => {
  it("converts agy display names to lowercase hyphenated slugs", () => {
    expect(toModelSlug("Gemini 3.5 Flash")).toBe("gemini-3.5-flash");
    expect(toModelSlug("Claude Sonnet 4.6 (Thinking)")).toBe("claude-sonnet-4.6-thinking");
    expect(toModelSlug("GPT-OSS 120B")).toBe("gpt-oss-120b");
    expect(toModelSlug("gemini-3.5-flash-medium")).toBe("gemini-3.5-flash-medium");
  });
});

describe("buildModelCatalog", () => {
  it("splits effort from modern stable model slugs", () => {
    const catalog = buildModelCatalog([
      "gemini-3.5-flash-medium",
      "gemini-3.5-flash-high",
      "claude-opus-4-6-thinking",
      "claude-sonnet-4-6",
      "gpt-oss-120b-medium"
    ]);

    expect(catalog.baseModels()).toEqual([
      "gemini-3.5-flash",
      "claude-opus-4-6-thinking",
      "claude-sonnet-4-6",
      "gpt-oss-120b"
    ]);
    expect(catalog.effectsFor("gemini-3.5-flash")).toEqual(["medium", "high"]);
    expect(catalog.effectsFor("claude-opus-4-6-thinking")).toEqual([]);
    expect(catalog.effectsFor("claude-sonnet-4-6")).toEqual([]);
    expect(catalog.effectsFor("gpt-oss-120b")).toEqual(["medium"]);
    expect(catalog.resolve("gemini-3.5-flash", "medium")).toBe("gemini-3.5-flash-medium");
    expect(catalog.split("gemini-3.5-flash-high")).toEqual({
      base: "gemini-3.5-flash",
      reasoningEffect: "high"
    });
    expect(catalog.agyBaseName("gemini-3.5-flash")).toBe("gemini-3.5-flash");
    expect(catalog.displayName("gemini-3.5-flash")).toBe("Gemini 3.5 Flash");
  });

  it("keeps -thinking slug models intact instead of treating thinking as effort", () => {
    const catalog = buildModelCatalog([
      "gemini-3.5-flash-medium",
      "claude-opus-4-6-thinking",
      "claude-sonnet-4-6"
    ]);

    expect(catalog.split("claude-opus-4-6-thinking")).toEqual({
      base: "claude-opus-4-6-thinking"
    });
    expect(catalog.effectsFor("claude-opus-4-6-thinking")).toEqual([]);
    const reasoningConfig = reasoningEffectConfigOption(
      "claude-opus-4-6-thinking",
      "none",
      catalog
    ) as SelectConfigOption;
    expect(reasoningConfig.options).toEqual([{ value: "none", name: "N/A" }]);
  });

  it("still splits legacy display-name model lists", () => {
    const catalog = buildModelCatalog([
      "Gemini 3.5 Flash (Medium)",
      "Gemini 3.5 Flash (High)",
      "Claude Sonnet 4.6 (Thinking)"
    ]);

    expect(catalog.baseModels()).toEqual([
      "gemini-3.5-flash",
      "claude-sonnet-4.6-thinking"
    ]);
    expect(catalog.effectsFor("gemini-3.5-flash")).toEqual(["medium", "high"]);
    expect(catalog.agyBaseName("gemini-3.5-flash")).toBe("Gemini 3.5 Flash");
    expect(catalog.resolve("gemini-3.5-flash", "medium")).toBe("Gemini 3.5 Flash (Medium)");
  });

  it("exposes mode, model, and reasoningEffort config options", () => {
    const catalog = buildModelCatalog(["gemini-3.5-flash-medium", "gemini-3.5-flash-high"]);
    const modelConfig = modelConfigOption("gemini-3.5-flash", catalog) as SelectConfigOption;
    const reasoningConfig = reasoningEffectConfigOption(
      "gemini-3.5-flash",
      "medium",
      catalog
    ) as SelectConfigOption;

    expect(modelConfig.id).toBe("model");
    expect(modelConfig.name).toBe("Model");
    expect(reasoningConfig.id).toBe("reasoningEffort");
    expect(reasoningConfig.name).toBe("Reasoning Effort");
    expect(modelConfig.options).toEqual([
      { value: "gemini-3.5-flash", name: "Gemini 3.5 Flash" }
    ]);
    expect(reasoningConfig.options).toEqual([
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" }
    ]);
  });
});

describe("session model config", () => {
  it("updates agy --model and --effort for later prompts", async () => {
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const spawnProcess = (command: string, args: string[], options: unknown) => {
      calls.push({ command, args, options });
      if (args[0] === "models") {
        return new FakeProcess([TEST_MODELS_OUTPUT]);
      }
      return new FakeProcess(["ok"]);
    };
    const updates: Array<{ content: { text: string } }> = [];
    const client = acpClient({ name: "test-client" })
      .onNotification(methods.client.session.update, (ctx) => {
        updates.push(ctx.params.update as { content: { text: string } });
      });
    const connection = client.connect(createAgyAcpApp({ env: printModeEnv(), spawnProcess: spawnProcess as unknown as SpawnFactory }));
    try {
      const session = await connection.agent.request(methods.agent.session.new, {
        cwd: "/repo",
        additionalDirectories: [],
        mcpServers: []
      });
      const configOptions = session.configOptions ?? [];
      expect(configOptions.map((option) => option.id)).toEqual(["mode", "model", "reasoningEffort"]);
      expect(configOptions.map((option) => option.name)).toEqual(["Mode", "Model", "Reasoning Effort"]);

      const modeConfig = configOptions[0] as SelectConfigOption;
      const modelConfig = configOptions[1] as SelectConfigOption;
      const reasoningConfig = configOptions[2] as SelectConfigOption;

      expect(modeConfig.category).toBe("mode");
      expect(modeConfig.currentValue).toBe("default");
      expect(optionValues(modeConfig)).toEqual(["default", "accept-edits", "plan"]);

      expect(modelConfig.category).toBe("model");
      expect(modelConfig.currentValue).toBe("gemini-3.5-flash");
      expect(modelConfig.options).toEqual([
        { value: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
        { value: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking" },
        { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }
      ]);

      expect(reasoningConfig.category).toBe("thought_level");
      expect(reasoningConfig.currentValue).toBe("medium");
      expect(reasoningConfig.options).toEqual([
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" }
      ]);
      expect(configOptions.find((option) => option.id === "effort" || option.id === "fast-mode")).toBeUndefined();

      const modelResponse = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "model",
        value: "gemini-3.5-flash"
      });
      expect(modelResponse.configOptions.map((option) => option.id)).toEqual([
        "mode",
        "model",
        "reasoningEffort"
      ]);
      expect(modelResponse.configOptions[1].currentValue).toBe("gemini-3.5-flash");
      expect(modelResponse.configOptions[2].currentValue).toBe("medium");
      expect(optionValues(modelResponse.configOptions[2] as SelectConfigOption)).toEqual(["medium", "high"]);

      const reasoningResponse = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "reasoningEffort",
        value: "high"
      });
      expect(reasoningResponse.configOptions[2].currentValue).toBe("high");

      const modeResponse = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "mode",
        value: "accept-edits"
      });
      expect(modeResponse.configOptions[0].currentValue).toBe("accept-edits");

      const thinkingResponse = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "model",
        value: "claude-opus-4-6-thinking"
      });
      expect(thinkingResponse.configOptions[1].currentValue).toBe("claude-opus-4-6-thinking");
      expect(thinkingResponse.configOptions[2].currentValue).toBe("none");
      expect(optionNames(thinkingResponse.configOptions[2] as SelectConfigOption)).toEqual(["N/A"]);

      await connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hi" }]
      });

      const promptCall = calls.find((call) => call.args.includes("--print"));
      expect(promptCall?.args[promptCall.args.indexOf("--print") + 1]).toBe("hi");
      expect(flagValue(promptCall!.args, "--model")).toBe("claude-opus-4-6-thinking");
      expect(promptCall!.args).not.toContain("--effort");
      expect(flagValue(promptCall!.args, "--mode")).toBe("accept-edits");
    } finally {
      connection.close();
    }
  });

  it("passes --effort for models with effort variants", async () => {
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const spawnProcess = (command: string, args: string[], options: unknown) => {
      calls.push({ command, args, options });
      if (args[0] === "models") {
        return new FakeProcess([TEST_MODELS_OUTPUT]);
      }
      return new FakeProcess(["ok"]);
    };
    const connection = acpClient({ name: "test-client" }).connect(
      createAgyAcpApp({ env: printModeEnv(), spawnProcess: spawnProcess as unknown as SpawnFactory })
    );
    try {
      const session = await connection.agent.request(methods.agent.session.new, {
        cwd: "/repo",
        additionalDirectories: [],
        mcpServers: []
      });
      await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "reasoningEffort",
        value: "high"
      });
      await connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hi" }]
      });
      const promptCall = calls.find((call) => call.args.includes("--print"));
      expect(flagValue(promptCall!.args, "--model")).toBe("gemini-3.5-flash");
      expect(flagValue(promptCall!.args, "--effort")).toBe("high");
    } finally {
      connection.close();
    }
  });
});

describe("ACP v2 (experimental draft)", () => {
  it("negotiates protocolVersion 2 with role-agnostic info/capabilities", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const connection = acpV2.client({ name: "test-client" }).connect(createAgyAcpV2App());
    try {
      const response = await connection.agent.request(acpV2.methods.agent.initialize, {
        protocolVersion: acpV2.PROTOCOL_VERSION,
        info: { name: "test-client", version: "0.0.0" },
        capabilities: {}
      });

      expect(response.protocolVersion).toBe(2);
      expect(response.info.name).toBe("agy-acp");
      expect(response.capabilities?.session?.prompt?.image).toEqual({});
      expect(response.capabilities?.session?.prompt?.embeddedContext).toEqual({});
      expect(response.capabilities?.session?.additionalDirectories).toEqual({});
      expect(installSpy).toHaveBeenCalledOnce();
    } finally {
      installSpy.mockRestore();
      connection.close();
    }
  });

  it("accepts session/prompt immediately and reports idle via state_update", async () => {
    await withConversationsDir(async (dir) => {
      const updates: unknown[] = [];
      const client = acpV2.client({ name: "test-client" }).onNotification(
        acpV2.methods.client.session.update,
        (ctx) => {
          updates.push(ctx.params.update);
        }
      );
      const connection = client.connect(
        createAgyAcpV2App({
          env: printModeEnv({ AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir }),
          spawnProcess: spawnAgyWritingConversation(dir, "conv-v2-1", [
            { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "hello v2" }) }
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
        const response = await connection.agent.request(acpV2.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hi" }]
        });

        // v2 prompt response is an empty acceptance ack (no stopReason).
        expect(response).toEqual({});

        await waitFor(() => updates.some((u) => (u as { state?: string }).state === "idle"));

        expect(updates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sessionUpdate: "user_message",
              content: [{ type: "text", text: "hi" }]
            }),
            expect.objectContaining({ sessionUpdate: "state_update", state: "running" }),
            expect.objectContaining({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hello v2" },
              messageId: expect.any(String)
            }),
            expect.objectContaining({
              sessionUpdate: "state_update",
              state: "idle",
              stopReason: "end_turn"
            })
          ])
        );
      } finally {
        connection.close();
      }
    });
  });

  it("replays history on session/resume with replayFrom start", async () => {
    await withConversationsDir(async (dir) => {
      const appOptions = {
        env: printModeEnv({ AGY_ACP_CONVERSATIONS_DIR: dir, AGY_ACP_STATE_DIR: dir }),
        spawnProcess: spawnAgyWritingConversation(dir, "conv-v2-replay", [
          { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "prior turn" }) }
        ])
      };

      let sessionId: string;
      {
        const updates: unknown[] = [];
        const client = acpV2.client({ name: "test-client" }).onNotification(
          acpV2.methods.client.session.update,
          (ctx) => {
            updates.push(ctx.params.update);
          }
        );
        const connection = client.connect(createAgyAcpV2App(appOptions));
        try {
          await connection.agent.request(acpV2.methods.agent.initialize, {
            protocolVersion: 2,
            info: { name: "test-client", version: "0.0.0" },
            capabilities: {}
          });
          const session = await connection.agent.request(acpV2.methods.agent.session.new, {
            cwd: "/repo"
          });
          sessionId = session.sessionId;
          await connection.agent.request(acpV2.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "hi" }]
          });
          // Drain the async turn so the conversation binding is persisted.
          await waitFor(() => updates.some((u) => (u as { state?: string }).state === "idle"));
        } finally {
          connection.close();
        }
      }

      {
        const updates: unknown[] = [];
        const client = acpV2.client({ name: "test-client" }).onNotification(
          acpV2.methods.client.session.update,
          (ctx) => {
            updates.push(ctx.params.update);
          }
        );
        const connection = client.connect(createAgyAcpV2App(appOptions));
        try {
          await connection.agent.request(acpV2.methods.agent.initialize, {
            protocolVersion: 2,
            info: { name: "test-client", version: "0.0.0" },
            capabilities: {}
          });
          await connection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId,
            cwd: "/repo",
            replayFrom: { type: "start" }
          });
          expect(updates).toContainEqual(
            expect.objectContaining({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "prior turn" },
              messageId: expect.any(String)
            })
          );
        } finally {
          connection.close();
        }
      }
    });
  });

  it("maps tool_call to tool_call_update and diffs to structured changes", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Edit /tmp/a.ts",
      kind: "edit",
      status: "completed",
      content: [{ type: "diff", path: "/tmp/a.ts", oldText: null, newText: "export {}\n" }]
    } as SessionUpdate;

    const v2Update = sessionUpdateToV2(update) as Record<string, unknown>;
    expect(v2Update.sessionUpdate).toBe("tool_call_update");
    const content = v2Update.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({
      type: "diff",
      changes: [{ operation: "add", path: "/tmp/a.ts", fileType: "text" }],
      patch: { format: "git_patch" }
    });
  });

  it("expands execute tool calls into terminal_update + tool_call_update", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "cmd-1",
      title: "ls",
      kind: "execute",
      status: "completed",
      rawInput: { CommandLine: "ls", Cwd: "/repo" },
      rawOutput: { exitCode: 0, output: "README.md\n" },
      content: [
        { type: "content", content: { type: "text", text: "```\nls\n```" } },
        { type: "content", content: { type: "text", text: "```\nREADME.md\n```" } }
      ]
    } as SessionUpdate;

    const expanded = expandSessionUpdateToV2(update) as Array<Record<string, unknown>>;
    expect(expanded).toHaveLength(2);

    const terminalId = terminalIdForToolCall("cmd-1");
    expect(expanded[0]).toMatchObject({
      sessionUpdate: "terminal_update",
      terminalId,
      command: "ls",
      cwd: "/repo",
      exitStatus: { exitCode: 0 }
    });
    expect((expanded[0].output as { data?: string })?.data).toBe(
      Buffer.from("README.md\n", "utf8").toString("base64")
    );

    expect(expanded[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd-1",
      kind: "execute",
      status: "completed"
    });
    const content = expanded[1].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "terminal", terminalId });
    expect(content.some((item) => item.type === "content")).toBe(true);
  });

  it("emits in-progress terminal_update without exitStatus", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "cmd-2",
      title: "sleep 1",
      kind: "execute",
      status: "in_progress",
      rawInput: { CommandLine: "sleep 1" }
    } as SessionUpdate;

    const [terminal, tool] = expandSessionUpdateToV2(update) as Array<Record<string, unknown>>;
    expect(terminal).toMatchObject({
      sessionUpdate: "terminal_update",
      terminalId: terminalIdForToolCall("cmd-2"),
      command: "sleep 1"
    });
    expect(terminal.exitStatus).toBeUndefined();
    expect(terminal.output).toBeUndefined();
    expect(tool).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "in_progress",
      content: [{ type: "terminal", terminalId: terminalIdForToolCall("cmd-2") }]
    });
  });
});

const TEST_MODELS_OUTPUT =
  "gemini-3.5-flash-medium\ngemini-3.5-flash-high\nclaude-opus-4-6-thinking\nclaude-sonnet-4-6\n";

function printModeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...overrides, AGY_ACP_INTERACTIVE_PERMISSIONS: "0" };
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
