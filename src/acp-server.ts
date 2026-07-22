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
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse
} from "@agentclientprotocol/sdk";
import { ReplayCache } from "./db/replay.js";
import { ensureAgyInstalled } from "./installer.js";
import { AgyCliBackend, configFromEnv, type AgyCliConfig, type AgyCliSession, type SpawnFactory } from "./cli.js";
import { promptBlocksToAgyPrompt } from "./prompt-content.js";
import { defaultStateDir, SessionStore, type StoredSession } from "./session-store.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
const MODEL_CONFIG_ID = "model";
const REASONING_EFFORT_CONFIG_ID = "effort";
const FAST_MODE_CONFIG_ID = "fast-mode";
const NO_REASONING_VALUE = "none";
/** Legacy `agy models` lines: `Gemini 3.5 Flash (Medium)`. */
const LEGACY_EFFORT_PATTERN = /\((low|medium|high)\)\s*$/i;
/** Legacy thinking models: `Claude Sonnet 4.6 (Thinking)`. */
const LEGACY_THINKING_PATTERN = /\(thinking\)\s*$/i;
/** Stable slug effort variants from agy ≥1.1.5: `gemini-3.5-flash-medium`. */
const SLUG_EFFORT_PATTERN = /^(.*)-(low|medium|high)$/i;
/** Stable slug thinking models: `claude-opus-4-6-thinking` (not an --effort value). */
const SLUG_THINKING_PATTERN = /-thinking$/i;
/** Conversation replays cached per conversation id before LRU eviction. */
const REPLAY_CACHE_CAPACITY = 32;

interface ModelCatalog {
  readonly entries: readonly string[];
  baseModels(): string[];
  effectsFor(baseModel: string): string[];
  resolve(baseModel: string, reasoningEffect: string): string;
  split(fullModel: string): { base: string; reasoningEffect?: string };
  /** Map a legacy agy display name (or base slug) to its ACP model slug, if known. */
  slugForAgyBase(agyBase: string): string | undefined;
  /**
   * Value for `agy --model`: base slug (modern) or legacy display base name.
   * Effort is passed separately via `--effort`.
   */
  agyBaseName(slug: string): string;
  /** Human-readable label for the model picker. */
  displayName(slug: string): string;
}

interface AgyAcpOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnFactory;
  argv?: string[];
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
  readonly #argv: string[];
  readonly #backend: AgyCliBackend;
  readonly #sessions = new Map<string, SessionState>();
  readonly #store: SessionStore;
  readonly #replayCache = new ReplayCache(REPLAY_CACHE_CAPACITY);
  #ensureAgyPromise: Promise<string | null> | undefined;

  constructor(options: AgyAcpOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#argv = options.argv ?? [];
    this.#backend = new AgyCliBackend(options.spawnProcess);
    this.#store = new SessionStore(defaultStateDir(this.#env));
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    await this.ensureAgyReady();
    return {
      protocolVersion: params.protocolVersion === PROTOCOL_VERSION ? params.protocolVersion : PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
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
          additionalDirectories: {},
          resume: {},
          close: {}
        }
      },
      agentInfo: {
        name: "agy-acp",
        title: "Google Antigravity CLI",
        version: packageJson.version ?? "0.0.0"
      }
    };
  }

  private ensureAgyReady(): Promise<string | null> {
    this.#ensureAgyPromise ??= ensureAgyInstalled({
      env: this.#env,
      warn: (message) => console.error(message)
    });
    return this.#ensureAgyPromise;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const cwd = params.cwd || process.cwd();
    const additionalDirectories = params.additionalDirectories ?? [];
    const workspaces = dedupe([cwd, ...additionalDirectories]);
    const id = randomUUID();
    const session = await this.buildSession(cwd, workspaces, null);
    session.id = id;
    this.#sessions.set(id, session);
    await this.persistSession(id, session);
    return {
      sessionId: id,
      configOptions: sessionConfigOptions(session)
    };
  }

  /**
   * `session/load`: reconstruct a previously persisted session and replay its
   * agy conversation history (if bound to one) before returning.
   */
  async loadSession(params: LoadSessionRequest, client: AgentContext): Promise<LoadSessionResponse> {
    const { session, cwd, stored } = await this.reloadSession(params.sessionId, params.cwd, params.additionalDirectories);

    if (stored.conversationId) {
      const replay = this.#replayCache.get(session.agy.config.conversationsDir, stored.conversationId, {
        skipNarration: false,
        cwd
      });
      if (replay) {
        for (const update of replay.updates) {
          await client.notify(methods.client.session.update, { sessionId: params.sessionId, update });
        }
      }
    }

    return { configOptions: sessionConfigOptions(session) };
  }

  /** `session/resume`: reconstruct a previously persisted session without replaying history. */
  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const { session } = await this.reloadSession(params.sessionId, params.cwd, params.additionalDirectories);
    return { configOptions: sessionConfigOptions(session) };
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
      await this.persistSession(params.sessionId, session);
      return {
        configOptions: sessionConfigOptions(session)
      };
    }

    if (params.configId === REASONING_EFFORT_CONFIG_ID) {
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
      await this.persistSession(params.sessionId, session);
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
      await this.persistSession(params.sessionId, session);
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

    const prompt = await promptBlocksToAgyPrompt(params.prompt, session.cwd);
    session.activePrompt = true;
    const cancelPrompt = () => {
      session.agy.cancel().catch(() => {
        // The prompt loop will surface process failures through its own result.
      });
    };
    signal?.addEventListener("abort", cancelPrompt, { once: true });

    try {
      const outcome = await session.agy.prompt(prompt, async (update) => {
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update });
      });
      await this.persistSession(params.sessionId, session);
      return {
        stopReason: outcome.stopReason === "cancelled" || signal?.aborted ? "cancelled" : "end_turn"
      };
    } catch (error) {
      // Persist even on failure: agy's conversation id/step position may have
      // advanced before it errored out, and that partial progress is worth
      // resuming from on the next prompt.
      await this.persistSession(params.sessionId, session).catch(() => {});
      throw error;
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

  /** Build a fresh session bound to `cwd`/`workspaces`, optionally resuming an
   *  agy conversation and a caller's prior model/mode selection. */
  private async buildSession(cwd: string, workspaces: string[], stored: StoredSession | null): Promise<SessionState> {
    const config = configFromEnv({ cwd, workspaces, env: this.#env, argv: this.#argv });
    const modelOptions = await this.modelOptionsForConfig(config);
    const catalog = buildModelCatalog(modelOptions);
    const agy = await this.#backend.startSession(config);

    if (stored?.conversationId) {
      agy.restoreConversation(stored.conversationId, stored.lastStepIdx);
    }

    const selection = stored
      ? restoredModelSelection(stored, catalog)
      : initialModelSelection(config.model, catalog);
    applyModelSelection(agy, selection.baseModel, selection.reasoningEffect, catalog);
    if (stored) {
      agy.setFastMode(stored.fastMode);
    }

    return {
      id: "", // set by the caller once the ACP session id is known
      cwd,
      workspaces,
      agy,
      catalog,
      selectedBaseModel: selection.baseModel,
      selectedReasoningEffect: selection.reasoningEffect,
      activePrompt: false
    };
  }

  /** Shared reconstruction for `session/load` and `session/resume`: restore a
   *  persisted session binding and re-register it in memory. */
  private async reloadSession(
    sessionId: string,
    requestedCwd: string | undefined,
    requestedDirs: string[] | undefined
  ): Promise<{ session: SessionState; cwd: string; stored: StoredSession }> {
    const stored = await this.#store.restore(sessionId);
    if (!stored) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const cwd = requestedCwd || stored.cwd;
    const workspaces = dedupe([cwd, ...(requestedDirs ?? stored.workspaces.filter((w) => w !== stored.cwd))]);

    const session = await this.buildSession(cwd, workspaces, stored);
    session.id = sessionId;
    this.#sessions.set(sessionId, session);
    return { session, cwd, stored };
  }

  private sessionRecord(session: SessionState): StoredSession {
    return {
      cwd: session.cwd,
      workspaces: session.workspaces,
      conversationId: session.agy.conversationId,
      lastStepIdx: session.agy.lastStepIdx,
      modelId: session.selectedBaseModel,
      reasoningEffect: session.selectedReasoningEffect,
      fastMode: session.agy.config.fastMode,
      updatedAt: new Date().toISOString()
    };
  }

  private persistSession(sessionId: string, session: SessionState): Promise<void> {
    return this.#store.persist(sessionId, this.sessionRecord(session));
  }
}

export function createAgyAcpApp(options: AgyAcpOptions = {}): AgentApp {
  const agy = new AgyAcpAgent(options);
  return acpAgent({ name: "agy-acp" })
    .onRequest(methods.agent.initialize, (ctx) => agy.initialize(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => agy.newSession(ctx.params))
    .onRequest(methods.agent.session.load, (ctx) => agy.loadSession(ctx.params, ctx.client))
    .onRequest(methods.agent.session.resume, (ctx) => agy.resumeSession(ctx.params))
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

export { promptBlocksToAgyPrompt, promptBlocksToText } from "./prompt-content.js";

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export function buildModelCatalog(entries: string[]): ModelCatalog {
  const uniqueEntries = dedupe(entries);
  const baseOrder: string[] = [];
  const effectsByBase = new Map<string, string[]>();
  const agyBaseBySlug = new Map<string, string>();
  const displayNameBySlug = new Map<string, string>();

  for (const entry of uniqueEntries) {
    const { agyBase, base, reasoningEffect, displayBase } = splitModelEntry(entry);
    if (!effectsByBase.has(base)) {
      baseOrder.push(base);
      effectsByBase.set(base, []);
      agyBaseBySlug.set(base, agyBase);
      displayNameBySlug.set(base, displayBase);
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
    split: (fullModel: string) => {
      const { base, reasoningEffect } = splitModelEntry(fullModel);
      return { base, reasoningEffect };
    },
    slugForAgyBase: (agyBase: string) => {
      const slug = toModelSlug(agyBase);
      if (agyBaseBySlug.has(slug)) {
        return slug;
      }
      // Stored full variant slug (e.g. gemini-3.5-flash-medium) or display line.
      const fromEntry = splitModelEntry(agyBase);
      return agyBaseBySlug.has(fromEntry.base) ? fromEntry.base : undefined;
    },
    agyBaseName: (slug: string) => {
      const agyBase = agyBaseBySlug.get(slug);
      if (!agyBase) {
        throw new Error(`Unknown model slug: ${slug}`);
      }
      return agyBase;
    },
    displayName: (slug: string) => {
      const name = displayNameBySlug.get(slug);
      if (!name) {
        throw new Error(`Unknown model slug: ${slug}`);
      }
      return name;
    }
  };
}

export function modelConfigOption(selectedBaseModel: string, catalog: ModelCatalog): SessionConfigOption {
  return {
    id: MODEL_CONFIG_ID,
    name: "Model",
    description: "ACP model slug passed to agy --model (effort is selected separately).",
    category: "model",
    type: "select",
    currentValue: selectedBaseModel,
    options: catalog.baseModels().map((slug) => ({
      value: slug,
      name: catalog.displayName(slug)
    }))
  };
}

export function reasoningEffectConfigOption(
  selectedBaseModel: string,
  selectedReasoningEffect: string,
  catalog: ModelCatalog
): SessionConfigOption {
  return {
    id: REASONING_EFFORT_CONFIG_ID,
    name: "Reasoning Effort",
    description: "Value for agy --effort (low | medium | high) for the selected model.",
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

/**
 * Split one `agy models` line into base model + optional effort.
 *
 * Modern (agy ≥1.1.5) lines are stable slugs, e.g.:
 *   gemini-3.5-flash-medium  → base gemini-3.5-flash, effort medium
 *   claude-opus-4-6-thinking → base claude-opus-4-6-thinking (thinking is not --effort)
 *   claude-sonnet-4-6        → base only
 *
 * Legacy display names remain supported:
 *   Gemini 3.5 Flash (Medium) → base gemini-3.5-flash, effort medium
 *   Claude Sonnet 4.6 (Thinking) → base claude-sonnet-4.6-thinking
 */
function splitModelEntry(model: string): {
  agyBase: string;
  base: string;
  displayBase: string;
  reasoningEffect?: string;
} {
  const trimmed = model.trim();

  // Legacy parenthetical thinking stays part of the model identity.
  if (LEGACY_THINKING_PATTERN.test(trimmed)) {
    const base = toModelSlug(trimmed);
    return { agyBase: trimmed, base, displayBase: trimmed };
  }

  // Legacy: `Gemini 3.5 Flash (Medium)`.
  const legacyEffort = trimmed.match(LEGACY_EFFORT_PATTERN);
  if (legacyEffort && legacyEffort.index !== undefined) {
    const displayBase = trimmed.slice(0, legacyEffort.index).trim();
    return {
      agyBase: displayBase,
      base: toModelSlug(displayBase),
      displayBase,
      reasoningEffect: legacyEffort[1].toLowerCase()
    };
  }

  // Modern thinking slug: not an --effort level.
  if (SLUG_THINKING_PATTERN.test(trimmed)) {
    const base = toModelSlug(trimmed);
    return {
      agyBase: base,
      base,
      displayBase: prettifyModelSlug(base)
    };
  }

  // Modern effort suffix on a stable slug.
  const slugEffort = trimmed.match(SLUG_EFFORT_PATTERN);
  if (slugEffort && isLikelyModelSlug(trimmed)) {
    const base = toModelSlug(slugEffort[1]);
    return {
      agyBase: base,
      base,
      displayBase: prettifyModelSlug(base),
      reasoningEffect: slugEffort[2].toLowerCase()
    };
  }

  // Plain slug or unknown free-form name.
  const base = toModelSlug(trimmed);
  const looksLikeSlug = isLikelyModelSlug(trimmed) || trimmed === base;
  return {
    agyBase: looksLikeSlug ? base : trimmed,
    base,
    displayBase: looksLikeSlug ? prettifyModelSlug(base) : trimmed
  };
}

/** Convert an agy display name (or slug) to an ACP-style model slug. */
export function toModelSlug(model: string): string {
  return model
    .toLowerCase()
    .replace(/[()]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/** True when `value` looks like a stable agy model slug rather than a display name. */
function isLikelyModelSlug(value: string): boolean {
  return /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(value.trim()) && !/\s/.test(value);
}

/** Humanize a model slug for picker labels: `gemini-3.5-flash` → `Gemini 3.5 Flash`. */
export function prettifyModelSlug(slug: string): string {
  const parts = slug.split("-").filter(Boolean);
  const merged: string[] = [];
  for (const part of parts) {
    // `claude-sonnet-4-6` → version `4.6` (hyphenated minor in the slug).
    if (/^\d+$/.test(part) && merged.length > 0 && /^\d+(?:\.\d+)*$/.test(merged[merged.length - 1]!)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}.${part}`;
      continue;
    }
    if (/^\d+(?:\.\d+)*$/.test(part)) {
      merged.push(part);
      continue;
    }
    if (part.toLowerCase() === "gpt" || part.toLowerCase() === "oss") {
      merged.push(part.toUpperCase());
      continue;
    }
    merged.push(part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
  }
  return merged.join(" ");
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
    name: reasoningEffectDisplayName(effect)
  }));
}

function reasoningEffectDisplayName(value: string): string {
  const labels: Record<string, string> = {
    low: "Low",
    medium: "Medium",
    high: "High"
  };
  return labels[value] ?? value;
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
      throw new Error("No models available. Ensure agy models succeeds.");
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

/** Like `initialModelSelection`, but for a persisted choice: falls back to the
 *  default selection if the model no longer appears in the current catalog. */
function restoredModelSelection(
  stored: StoredSession,
  catalog: ModelCatalog
): { baseModel: string; reasoningEffect: string } {
  const baseModel = normalizeStoredBaseModel(stored.modelId, catalog);
  if (!baseModel) {
    return initialModelSelection(undefined, catalog);
  }
  const effects = catalog.effectsFor(baseModel);
  if (effects.length === 0) {
    return { baseModel, reasoningEffect: NO_REASONING_VALUE };
  }
  return {
    baseModel,
    reasoningEffect: normalizeStoredReasoningEffect(stored.reasoningEffect, effects)
  };
}

function normalizeStoredBaseModel(modelId: string, catalog: ModelCatalog): string | undefined {
  if (catalog.baseModels().includes(modelId)) {
    return modelId;
  }
  return catalog.slugForAgyBase(modelId);
}

function normalizeStoredReasoningEffect(storedEffect: string, effects: string[]): string {
  if (effects.includes(storedEffect)) {
    return storedEffect;
  }
  const lower = storedEffect.toLowerCase();
  if (effects.includes(lower)) {
    return lower;
  }
  const legacyEffects: Record<string, string> = {
    Low: "low",
    Medium: "medium",
    High: "high"
  };
  const mapped = legacyEffects[storedEffect];
  if (mapped && effects.includes(mapped)) {
    return mapped;
  }
  if (storedEffect === "__none__" || storedEffect === NO_REASONING_VALUE) {
    return NO_REASONING_VALUE;
  }
  return effects[0];
}

function applyModelSelection(
  agy: AgyCliSession,
  selectedBaseModel: string,
  selectedReasoningEffect: string,
  catalog: ModelCatalog
): void {
  // agy ≥1.1.5: --model is the base (slug or legacy display base), --effort is separate.
  agy.setModel(catalog.agyBaseName(selectedBaseModel));

  const effects = catalog.effectsFor(selectedBaseModel);
  if (effects.length === 0) {
    agy.setEffort(undefined);
    return;
  }

  if (selectedReasoningEffect === NO_REASONING_VALUE || !effects.includes(selectedReasoningEffect)) {
    agy.setEffort(effects[0]);
    return;
  }

  agy.setEffort(selectedReasoningEffect);
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
