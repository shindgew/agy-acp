import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Readable, Writable } from "node:stream";
import {
  agent as acpAgent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentContext,
  type AgentApp,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse
} from "@agentclientprotocol/sdk";
import { AgyCliBackend, configFromEnv, type AgyCliConfig, type AgyCliSession, type SpawnFactory } from "./agy-cli.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
const MODEL_CONFIG_ID = "agy.model";
const REASONING_EFFECT_CONFIG_ID = "agy.reasoning_effect";
const FAST_MODE_CONFIG_ID = "agy.fast_mode";
const NO_REASONING_VALUE = "__none__";
const REASONING_EFFECT_PATTERN = /\((low|medium|high)\)\s*$/i;
const THINKING_SUFFIX_PATTERN = /\(thinking\)\s*$/i;

interface ModelCatalog {
  readonly entries: readonly string[];
  baseModels(): string[];
  effectsFor(baseModel: string): string[];
  resolve(baseModel: string, reasoningEffect: string): string;
  split(fullModel: string): { base: string; reasoningEffect?: string };
}

interface AgyAcpOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnFactory;
}

interface SessionState {
  id: string;
  cwd: string;
  workspaces: string[];
  agy: AgyCliSession;
  catalog: ModelCatalog;
  selectedBaseModel: string;
  selectedReasoningEffect: string;
  activePrompt: boolean;
}

export class AgyAcpAgent {
  readonly #env: NodeJS.ProcessEnv;
  readonly #backend: AgyCliBackend;
  readonly #sessions = new Map<string, SessionState>();

  constructor(options: AgyAcpOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#backend = new AgyCliBackend(options.spawnProcess);
  }

  initialize(params: InitializeRequest): InitializeResponse {
    return {
      protocolVersion: params.protocolVersion === PROTOCOL_VERSION ? params.protocolVersion : PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true
        },
        mcpCapabilities: {
          http: false,
          sse: false,
          acp: false
        },
        sessionCapabilities: {
          additionalDirectories: {}
        }
      },
      agentInfo: {
        name: "agy-acp",
        title: "Google Antigravity CLI",
        version: packageJson.version ?? "0.0.0"
      }
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const cwd = params.cwd || process.cwd();
    const additionalDirectories = params.additionalDirectories ?? [];
    const workspaces = dedupe([cwd, ...additionalDirectories]);
    const id = randomUUID();
    const config = configFromEnv({ cwd, workspaces, env: this.#env });
    const modelOptions = await this.modelOptionsForConfig(config);
    const catalog = buildModelCatalog(modelOptions);
    const agy = await this.#backend.startSession(config);
    const initialSelection = initialModelSelection(config.model, catalog);
    applyModelSelection(agy, initialSelection.baseModel, initialSelection.reasoningEffect, catalog);
    const session: SessionState = {
      id,
      cwd,
      workspaces,
      agy,
      catalog,
      selectedBaseModel: initialSelection.baseModel,
      selectedReasoningEffect: initialSelection.reasoningEffect,
      activePrompt: false
    };
    this.#sessions.set(id, session);
    return {
      sessionId: id,
      configOptions: sessionConfigOptions(session)
    };
  }

  async setConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const session = this.requireSession(params.sessionId);
    if (params.configId === MODEL_CONFIG_ID) {
      if (typeof params.value !== "string") {
        throw new Error("Model config value must be a string");
      }
      if (!session.catalog.baseModels().includes(params.value)) {
        throw new Error(`Unknown model: ${params.value}`);
      }

      session.selectedBaseModel = params.value;
      session.selectedReasoningEffect = defaultReasoningEffectForBase(params.value, session.catalog);
      applyModelSelection(
        session.agy,
        session.selectedBaseModel,
        session.selectedReasoningEffect,
        session.catalog
      );
      return {
        configOptions: sessionConfigOptions(session)
      };
    }

    if (params.configId === REASONING_EFFECT_CONFIG_ID) {
      if (typeof params.value !== "string") {
        throw new Error("Reasoning effect config value must be a string");
      }
      const allowedEffects = reasoningEffectValues(session.selectedBaseModel, session.catalog);
      if (!allowedEffects.includes(params.value)) {
        throw new Error(`Unknown reasoning effect: ${params.value}`);
      }

      session.selectedReasoningEffect = params.value;
      applyModelSelection(
        session.agy,
        session.selectedBaseModel,
        session.selectedReasoningEffect,
        session.catalog
      );
      return {
        configOptions: sessionConfigOptions(session)
      };
    }

    if (params.configId === FAST_MODE_CONFIG_ID) {
      const enabled = fastModeValueToBoolean(params.value);
      if (enabled === undefined) {
        throw new Error("Fast mode config value must be on or off");
      }
      session.agy.setFastMode(enabled);
      return {
        configOptions: sessionConfigOptions(session)
      };
    }

    throw new Error(`Unknown config option: ${params.configId}`);
  }

  async prompt(params: PromptRequest, client: AgentContext, signal?: AbortSignal): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);
    if (session.activePrompt) {
      throw new Error(`Session already has an active prompt: ${params.sessionId}`);
    }

    const prompt = promptBlocksToText(params.prompt);
    session.activePrompt = true;
    const cancelPrompt = () => {
      session.agy.cancel().catch(() => {
        // The prompt loop will surface process failures through its own result.
      });
    };
    signal?.addEventListener("abort", cancelPrompt, { once: true });

    try {
      for await (const chunk of session.agy.prompt(prompt)) {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: chunk }
          }
        });
      }
      return {
        stopReason: session.agy.wasCancelled || signal?.aborted ? "cancelled" : "end_turn"
      };
    } finally {
      signal?.removeEventListener("abort", cancelPrompt);
      session.activePrompt = false;
    }
  }

  async cancel(params: { sessionId: string }): Promise<void> {
    const session = this.#sessions.get(params.sessionId);
    await session?.agy.cancel();
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.#sessions.get(params.sessionId);
    this.#sessions.delete(params.sessionId);
    await session?.agy.close();
    return {};
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  private async modelOptionsForConfig(config: AgyCliConfig): Promise<string[]> {
    try {
      return await this.#backend.listModels(config);
    } catch {
      return config.model ? [config.model] : [];
    }
  }
}

export function createAgyAcpApp(options: AgyAcpOptions = {}): AgentApp {
  const agy = new AgyAcpAgent(options);
  return acpAgent({ name: "agy-acp" })
    .onRequest(methods.agent.initialize, (ctx) => agy.initialize(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => agy.newSession(ctx.params))
    .onRequest(methods.agent.session.setConfigOption, (ctx) => agy.setConfigOption(ctx.params))
    .onRequest(methods.agent.session.prompt, (ctx) => agy.prompt(ctx.params, ctx.client, ctx.signal))
    .onRequest(methods.agent.session.close, (ctx) => agy.closeSession(ctx.params))
    .onNotification(methods.agent.session.cancel, (ctx) => agy.cancel(ctx.params));
}

export function runAcp(options: AgyAcpOptions = {}) {
  const stdout = (options.stdout ?? process.stdout) as Writable;
  const stdin = (options.stdin ?? process.stdin) as Readable;
  const stream = ndJsonStream(
    Writable.toWeb(stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(stdin) as ReadableStream<Uint8Array>
  );
  return createAgyAcpApp(options).connect(stream);
}

export function promptBlocksToText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "resource_link") {
      parts.push(`Referenced resource: ${block.uri}`);
    } else if (block.type === "resource") {
      parts.push(resourceBlockToText(block));
    }
  }
  return parts.join("\n");
}

function resourceBlockToText(block: Extract<ContentBlock, { type: "resource" }>): string {
  const resource = block.resource;
  if ("text" in resource) {
    return `Resource ${resource.uri}:\n${resource.text}`;
  }
  return `Resource ${resource.uri}: [${resource.mimeType ?? "application/octet-stream"} blob omitted]`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export function buildModelCatalog(entries: string[]): ModelCatalog {
  const uniqueEntries = dedupe(entries);
  const baseOrder: string[] = [];
  const effectsByBase = new Map<string, string[]>();

  for (const entry of uniqueEntries) {
    const { base, reasoningEffect } = splitModelEntry(entry);
    if (!effectsByBase.has(base)) {
      baseOrder.push(base);
      effectsByBase.set(base, []);
    }
    if (reasoningEffect) {
      const effects = effectsByBase.get(base)!;
      if (!effects.includes(reasoningEffect)) {
        effects.push(reasoningEffect);
      }
    }
  }

  return {
    entries: uniqueEntries,
    baseModels: () => baseOrder,
    effectsFor: (baseModel: string) => effectsByBase.get(baseModel) ?? [],
    resolve: (baseModel: string, reasoningEffect: string) => {
      const resolved = uniqueEntries.find((entry) => {
        const parsed = splitModelEntry(entry);
        return parsed.base === baseModel && parsed.reasoningEffect === reasoningEffect;
      });
      if (!resolved) {
        throw new Error(`Unknown model selection: ${baseModel} (${reasoningEffect})`);
      }
      return resolved;
    },
    split: (fullModel: string) => splitModelEntry(fullModel)
  };
}

export function modelConfigOption(selectedBaseModel: string, catalog: ModelCatalog): SessionConfigOption {
  return {
    id: MODEL_CONFIG_ID,
    name: "Model",
    description: "Antigravity model base name passed to agy --model.",
    category: "model",
    type: "select",
    currentValue: selectedBaseModel,
    options: catalog.baseModels().map((baseModel) => ({
      value: baseModel,
      name: baseModel
    }))
  };
}

export function reasoningEffectConfigOption(
  selectedBaseModel: string,
  selectedReasoningEffect: string,
  catalog: ModelCatalog
): SessionConfigOption {
  return {
    id: REASONING_EFFECT_CONFIG_ID,
    name: "Reasoning Effect",
    description: "Reasoning effort suffix appended to the selected model.",
    category: "thought_level",
    type: "select",
    currentValue: selectedReasoningEffect,
    options: reasoningEffectOptions(selectedBaseModel, catalog)
  };
}

export function fastModeConfigOption(enabled: boolean): SessionConfigOption {
  return {
    id: FAST_MODE_CONFIG_ID,
    name: "Fast Mode",
    description: "Prepends /fast before agy --print prompts to reduce thought visualization delays.",
    category: "model_config",
    type: "select",
    currentValue: enabled ? "on" : "off",
    options: [
      {
        value: "off",
        name: "Off"
      },
      {
        value: "on",
        name: "On"
      }
    ]
  };
}

function sessionConfigOptions(session: SessionState): SessionConfigOption[] {
  return [
    modelConfigOption(session.selectedBaseModel, session.catalog),
    reasoningEffectConfigOption(
      session.selectedBaseModel,
      session.selectedReasoningEffect,
      session.catalog
    ),
    fastModeConfigOption(session.agy.config.fastMode)
  ];
}

function splitModelEntry(model: string): { base: string; reasoningEffect?: string } {
  if (THINKING_SUFFIX_PATTERN.test(model)) {
    return { base: model };
  }

  const match = model.match(REASONING_EFFECT_PATTERN);
  if (!match || match.index === undefined) {
    return { base: model };
  }

  return {
    base: model.slice(0, match.index).trim(),
    reasoningEffect: reasoningEffectLabel(match[1])
  };
}

function reasoningEffectLabel(value: string): string {
  const normalized = value.toLowerCase();
  const labels: Record<string, string> = {
    low: "Low",
    medium: "Medium",
    high: "High"
  };
  return labels[normalized] ?? value;
}

function reasoningEffectOptions(
  selectedBaseModel: string,
  catalog: ModelCatalog
): Extract<SessionConfigOption, { type: "select" }>["options"] {
  const effects = catalog.effectsFor(selectedBaseModel);
  if (effects.length === 0) {
    return [
      {
        value: NO_REASONING_VALUE,
        name: "N/A"
      }
    ];
  }

  return effects.map((effect) => ({
    value: effect,
    name: effect
  }));
}

function reasoningEffectValues(selectedBaseModel: string, catalog: ModelCatalog): string[] {
  return reasoningEffectOptions(selectedBaseModel, catalog)
    .map((option) => ("value" in option ? option.value : undefined))
    .filter((value): value is string => value !== undefined);
}

function defaultReasoningEffectForBase(selectedBaseModel: string, catalog: ModelCatalog): string {
  const effects = catalog.effectsFor(selectedBaseModel);
  return effects[0] ?? NO_REASONING_VALUE;
}

function initialModelSelection(
  configuredModel: string | undefined,
  catalog: ModelCatalog
): { baseModel: string; reasoningEffect: string } {
  if (!configuredModel) {
    const [firstBaseModel] = catalog.baseModels();
    if (!firstBaseModel) {
      throw new Error("No models available. Configure AGY_ACP_MODELS or ensure agy models succeeds.");
    }
    return {
      baseModel: firstBaseModel,
      reasoningEffect: defaultReasoningEffectForBase(firstBaseModel, catalog)
    };
  }

  const { base, reasoningEffect } = catalog.split(configuredModel);
  const effects = catalog.effectsFor(base);
  if (effects.length === 0) {
    return {
      baseModel: base,
      reasoningEffect: NO_REASONING_VALUE
    };
  }

  return {
    baseModel: base,
    reasoningEffect: reasoningEffect && effects.includes(reasoningEffect)
      ? reasoningEffect
      : effects[0]
  };
}

function applyModelSelection(
  agy: AgyCliSession,
  selectedBaseModel: string,
  selectedReasoningEffect: string,
  catalog: ModelCatalog
): void {
  const effects = catalog.effectsFor(selectedBaseModel);
  if (effects.length === 0) {
    agy.setModel(selectedBaseModel);
    return;
  }

  if (selectedReasoningEffect === NO_REASONING_VALUE || !effects.includes(selectedReasoningEffect)) {
    agy.setModel(catalog.resolve(selectedBaseModel, effects[0]));
    return;
  }

  agy.setModel(catalog.resolve(selectedBaseModel, selectedReasoningEffect));
}

function fastModeValueToBoolean(value: unknown): boolean | undefined {
  if (value === true || value === "on") {
    return true;
  }
  if (value === false || value === "off") {
    return false;
  }
  return undefined;
}
