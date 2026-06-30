import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { client as acpClient, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
  buildModelCatalog,
  classifyAgyOutputText,
  createAgyAcpApp,
  modelConfigOption,
  promptBlocksToText,
  reasoningEffectConfigOption
} from "../src/acp-server.js";
import type { SpawnFactory } from "../src/agy-cli.js";
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

describe("classifyAgyOutputText", () => {
  it("marks agy progress lines as thought chunks", () => {
    expect(classifyAgyOutputText([
      "I will search the web for Agent Chat Protocol.\n",
      "I will run the agy changelog command.\n",
      "I will view .gitignore in the agy-acp project.\n",
      "I will import mkdtemp, rm, os, and path in tests/acp-server.test.ts.\n",
      "ACP uses session updates for streaming.\n"
    ].join(""))).toEqual([
      {
        kind: "thought",
        text: "I will search the web for Agent Chat Protocol.\n"
      },
      {
        kind: "thought",
        text: "I will run the agy changelog command.\n"
      },
      {
        kind: "thought",
        text: "I will view .gitignore in the agy-acp project.\n"
      },
      {
        kind: "thought",
        text: "I will import mkdtemp, rm, os, and path in tests/acp-server.test.ts.\n"
      },
      {
        kind: "message",
        text: "ACP uses session updates for streaming.\n"
      }
    ]);
  });

  it("keeps lowercase progress continuations inside the active thought chunk", () => {
    expect(classifyAgyOutputText([
      "I will test the server prompt interface.\n",
      "the server prompt interface is tested.\n",
      "Final answer.\n"
    ].join(""))).toEqual([
      {
        kind: "thought",
        text: "I will test the server prompt interface.\n"
      },
      {
        kind: "thought",
        text: "the server prompt interface is tested.\n"
      },
      {
        kind: "message",
        text: "Final answer.\n"
      }
    ]);
  });

  it("strips explicit thought markers", () => {
    expect(classifyAgyOutputText("<thinking>I will inspect the adapter.</thinking>\nDone")).toEqual([
      {
        kind: "thought",
        text: "I will inspect the adapter.\n"
      },
      {
        kind: "message",
        text: "Done"
      }
    ]);
  });
});

describe("initialize", () => {
  it("returns SDK-validated ACP capabilities", async () => {
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
    } finally {
      connection.close();
    }
  });
});

describe("session prompt", () => {
  it("streams agy output as ACP message chunks", async () => {
    const updates: unknown[] = [];
    const client = acpClient({ name: "test-client" })
      .onNotification(methods.client.session.update, (ctx) => {
        updates.push(ctx.params.update);
      });
    const connection = client.connect(createAgyAcpApp({
      spawnProcess: spawnAgyProcess(["hello"])
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

  it("streams recognized agy progress output as a visible thinking tool call", async () => {
    const updates: unknown[] = [];
    const client = acpClient({ name: "test-client" })
      .onNotification(methods.client.session.update, (ctx) => {
        updates.push(ctx.params.update);
      });
    const connection = client.connect(createAgyAcpApp({
      spawnProcess: spawnAgyProcess([
        "I will test ",
        "the server prompt interface.\nthe server prompt interface is tested.\nFinal answer.\n"
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

      const thoughtText = [
        "I will test the server prompt interface.\n",
        "the server prompt interface is tested.\n"
      ].join("");
      expect(updates).toMatchObject([
        {
          sessionUpdate: "tool_call",
          toolCallId: expect.any(String),
          title: "Thinking",
          kind: "think",
          status: "in_progress",
          content: [
            {
              type: "content",
              content: { type: "text", text: "I will test the server prompt interface.\n" }
            }
          ]
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: expect.any(String),
          status: "in_progress",
          content: [
            {
              type: "content",
              content: { type: "text", text: thoughtText }
            }
          ]
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: expect.any(String),
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: thoughtText }
            }
          ]
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Final answer.\n" }
        }
      ]);
      expect(response.stopReason).toBe("end_turn");
    } finally {
      connection.close();
    }
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
      const modelConfig = configOptions.find((option) => option.id === "agy.model") as SelectConfigOption | undefined;
      const reasoningConfig = configOptions.find((option) => option.id === "agy.reasoning_effect") as SelectConfigOption | undefined;
      const fastConfig = configOptions.find((option) => option.id === "agy.fast_mode") as SelectConfigOption | undefined;

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
        configId: "agy.model",
        value: "Gemini 3.5 Flash"
      });
      expect(modelResponse.configOptions[0].currentValue).toBe("Gemini 3.5 Flash");
      expect(modelResponse.configOptions[1].currentValue).toBe("Medium");
      expect(optionValues(modelResponse.configOptions[1] as SelectConfigOption)).toEqual(["Medium", "High"]);

      const reasoningResponse = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "agy.reasoning_effect",
        value: "High"
      });
      expect(reasoningResponse.configOptions[1].currentValue).toBe("High");

      const fastResponse = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "agy.fast_mode",
        value: "on"
      });
      expect(fastResponse.configOptions[2].currentValue).toBe("on");

      const thinkingResponse = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "agy.model",
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
      expect(updates[0].content.text).toBe("ok");
    } finally {
      connection.close();
    }
  });
});

const TEST_MODELS_OUTPUT = "Gemini 3.5 Flash (Medium)\nGemini 3.5 Flash (High)\nClaude Sonnet 4.6 (Thinking)\n";

function spawnAgyProcess(promptChunks: string[]): SpawnFactory {
  return ((command: string, args: string[]) => {
    if (args[0] === "models") {
      return new FakeProcess([TEST_MODELS_OUTPUT]);
    }
    return new FakeProcess(promptChunks);
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
