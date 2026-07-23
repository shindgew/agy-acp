// ACP Agent: dual v1 / draft-v2 agent methods (initialize, session/*, prompt loop).
// Section helpers live under folders named after ACP docs slugs
// (content/, session/, slash-commands/, tool-calls/, file-system/, agent-plan/).
// Backend (agy CLI + conversation DB) lives under agy/.

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Readable, Writable } from "node:stream";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { RequestError } from "@agentclientprotocol/sdk";
import type {
  AgentContext as V1AgentContext,
  AgentApp as V1AgentApp,
  AuthenticateRequest,
  AuthenticateResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  InitializeRequest as V1InitializeRequest,
  InitializeResponse as V1InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  LogoutRequest,
  LogoutResponse,
  NewSessionRequest as V1NewSessionRequest,
  NewSessionResponse as V1NewSessionResponse,
  PromptRequest as V1PromptRequest,
  PromptResponse as V1PromptResponse,
  ResumeSessionRequest as V1ResumeSessionRequest,
  ResumeSessionResponse as V1ResumeSessionResponse,
  SessionConfigOption as V1SessionConfigOption,
  SessionModeState,
  SetSessionConfigOptionRequest as V1SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse as V1SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse
} from "@agentclientprotocol/sdk";
import type {
  AgentContext as V2AgentContext,
  AgentApp as V2AgentApp,
  InitializeRequest as V2InitializeRequest,
  InitializeResponse as V2InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoginAuthRequest,
  LoginAuthResponse,
  LogoutAuthRequest,
  LogoutAuthResponse,
  NewSessionRequest as V2NewSessionRequest,
  NewSessionResponse as V2NewSessionResponse,
  PromptRequest as V2PromptRequest,
  PromptResponse as V2PromptResponse,
  ResumeSessionRequest as V2ResumeSessionRequest,
  ResumeSessionResponse as V2ResumeSessionResponse,
  SessionConfigOption as V2SessionConfigOption,
  SetSessionConfigOptionRequest as V2SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse as V2SetSessionConfigOptionResponse
} from "@agentclientprotocol/sdk/experimental/v2";
import { ReplayCache } from "./agy/db/replay.js";
import type { ClientFileSystem } from "./file-system/bridge.js";
import { ensureAgyInstalled } from "./agy/installer.js";
import {
  AUTH_METHOD_TERMINAL_LOGIN,
  isAgyAuthenticated,
  isKnownAuthMethodId,
  logoutAgyViaSlashCommand,
  v1AuthMethods,
  v2AuthMethods
} from "./agy/auth.js";
import {
  AgyCliBackend,
  SESSION_MODE_IDS,
  configFromEnv,
  isSessionModeId,
  type AgyCliConfig,
  type AgyCliSession,
  type SessionModeId,
  type PtyFactory,
  type SpawnFactory
} from "./agy/cli.js";
import { permissionOptions, type PermissionChoice } from "./tool-calls/permissions.js";
import { contentBlocksToPrompt } from "./content/index.js";
import { defaultStateDir, SessionStore, type StoredSession } from "./session/store.js";
import { expandSessionUpdateToV2, sessionUpdateToV1, sessionUpdateToV2 } from "./session/updates.js";
import {
  availableCommandsUpdate,
  interpretSlashCommand,
  parseSlashCommand,
  resolveModelValue
} from "./slash-commands/index.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
const MODE_CONFIG_ID = "mode";
const MODEL_CONFIG_ID = "model";
const REASONING_EFFORT_CONFIG_ID = "reasoningEffort";
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
  effortsFor(baseModel: string): string[];
  resolve(baseModel: string, reasoningEffort: string): string;
  split(fullModel: string): { base: string; reasoningEffort?: string };
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

export interface AcpAgentOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnFactory;
  ptyFactory?: PtyFactory;
  argv?: string[];
}

interface SessionState {
  sessionId: string;
  cwd: string;
  /** ACP additionalDirectories (excludes cwd). */
  additionalDirectories: string[];
  agy: AgyCliSession;
  catalog: ModelCatalog;
  selectedBaseModel: string;
  selectedReasoningEffort: string;
  activePrompt: boolean;
  /** Active v2 prompt-turn abort controller, if any. */
  promptAbort?: AbortController;
}

/**
 * Runs `fn` after the current request handler's response has gone out on the
 * wire. The ACP connection queues outbound messages in call order, so a
 * `setImmediate` — which only fires once the microtask queue (including the
 * response's own send) has drained — is enough to guarantee it lands second.
 */
function deferAfterResponse(fn: () => Promise<void>): void {
  setImmediate(() => {
    fn().catch(() => {
      // Connection may already be closed by the time this fires (client
      // disconnected right after session/new) — nothing left to notify.
    });
  });
}

export class AcpAgent {
  readonly #env: NodeJS.ProcessEnv;
  readonly #argv: string[];
  readonly #backend: AgyCliBackend;
  readonly #sessions = new Map<string, SessionState>();
  readonly #store: SessionStore;
  readonly #replayCache = new ReplayCache(REPLAY_CACHE_CAPACITY);
  #ensureAgyPromise: Promise<string | null> | undefined;
  /** v1 client's `fs` capability, set from `initialize`. Draft v2 has no fs/* client methods. */
  #clientFs = { readTextFile: false, writeTextFile: false };

  constructor(options: AcpAgentOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#argv = options.argv ?? [];
    this.#backend = new AgyCliBackend(options.spawnProcess, options.ptyFactory);
    this.#store = new SessionStore(defaultStateDir(this.#env));
  }

  async initializeV1(params: V1InitializeRequest): Promise<V1InitializeResponse> {
    await this.ensureAgyReady();
    this.#clientFs = {
      readTextFile: params.clientCapabilities?.fs?.readTextFile ?? false,
      writeTextFile: params.clientCapabilities?.fs?.writeTextFile ?? false
    };
    return {
      protocolVersion:
        params.protocolVersion === v1.PROTOCOL_VERSION ? params.protocolVersion : v1.PROTOCOL_VERSION,
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
          list: {},
          additionalDirectories: {},
          resume: {},
          close: {}
        },
        auth: {
          logout: {}
        }
      },
      authMethods: v1AuthMethods(),
      agentInfo: {
        name: "agy-acp",
        title: "Google Antigravity CLI",
        version: packageJson.version ?? "0.0.0"
      }
    };
  }

  async initializeV2(params: V2InitializeRequest): Promise<V2InitializeResponse> {
    await this.ensureAgyReady();
    return {
      protocolVersion:
        params.protocolVersion === v2.PROTOCOL_VERSION ? params.protocolVersion : v2.PROTOCOL_VERSION,
      info: {
        name: "agy-acp",
        title: "Google Antigravity CLI",
        version: packageJson.version ?? "0.0.0"
      },
      // Advertising `session` commits to the v2 baseline methods (new/list/resume/close/prompt/cancel/update).
      capabilities: {
        session: {
          prompt: {
            image: {},
            embeddedContext: {}
          },
          additionalDirectories: {}
        },
        auth: {}
      },
      // Non-empty authMethods commits the agent to auth/login + auth/logout.
      authMethods: v2AuthMethods()
    };
  }

  private ensureAgyReady(): Promise<string | null> {
    this.#ensureAgyPromise ??= ensureAgyInstalled({
      env: this.#env,
      warn: (message) => console.error(message)
    });
    return this.#ensureAgyPromise;
  }

  /** Probe config for auth checks (cwd only; no workspace roots required). */
  private authProbeConfig(cwd = process.cwd()): AgyCliConfig {
    return configFromEnv({ cwd, env: this.#env, argv: this.#argv });
  }

  /**
   * Ensure agy is signed in. Throws ACP `auth_required` when not authenticated.
   */
  private async requireAuthenticated(cwd?: string): Promise<void> {
    await this.ensureAgyReady();
    const status = await isAgyAuthenticated(this.#backend, this.authProbeConfig(cwd));
    if (status.ok) return;
    throw RequestError.authRequired(
      { authMethods: v1AuthMethods() },
      status.reason
    );
  }

  /**
   * v1 `authenticate` / v2 `auth/login`: confirm keyring login after terminal auth,
   * or succeed immediately when already signed in.
   */
  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    await this.ensureAgyReady();
    if (!isKnownAuthMethodId(params.methodId)) {
      throw RequestError.invalidParams({ methodId: params.methodId }, `Unknown auth method: ${params.methodId}`);
    }
    const status = await isAgyAuthenticated(this.#backend, this.authProbeConfig());
    if (status.ok) return {};
    throw RequestError.authRequired(
      { authMethods: v1AuthMethods() },
      `${status.reason} Complete terminal login (method "${AUTH_METHOD_TERMINAL_LOGIN}"), then call authenticate again.`
    );
  }

  async loginAuth(params: LoginAuthRequest): Promise<LoginAuthResponse> {
    // v2 uses methodId; same probe semantics as v1 authenticate.
    return this.authenticate({ methodId: params.methodId });
  }

  /** v1 `logout` / v2 `auth/logout`: best-effort agy TUI `/logout`. */
  async logout(_params: LogoutRequest = {}): Promise<LogoutResponse> {
    await this.ensureAgyReady();
    const config = this.authProbeConfig();
    try {
      await logoutAgyViaSlashCommand({
        backend: this.#backend,
        config,
        ptyFactory: this.#backend.ptyFactory
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw RequestError.internalError(undefined, `agy logout failed: ${message}`);
    }
    return {};
  }

  async logoutAuth(params: LogoutAuthRequest = {}): Promise<LogoutAuthResponse> {
    return this.logout(params);
  }

  /**
   * When the client advertises `fs.readTextFile` + `fs.writeTextFile`, route
   * already-applied edits through those methods so the client's own
   * diff/review UI (e.g. Zed's Review Changes panel) tracks them. Draft v2
   * has no fs/* client methods, so this is v1-only.
   */
  private clientFileSystemV1(client: V1AgentContext, sessionId: string): ClientFileSystem | undefined {
    if (!this.#clientFs.readTextFile || !this.#clientFs.writeTextFile) return undefined;
    return {
      readTextFile: async (path) => {
        await client.request(v1.methods.client.fs.readTextFile, { sessionId, path });
      },
      writeTextFile: async (path, content) => {
        await client.request(v1.methods.client.fs.writeTextFile, { sessionId, path, content });
      }
    };
  }

  async newSessionV1(
    params: V1NewSessionRequest,
    client?: V1AgentContext
  ): Promise<V1NewSessionResponse> {
    await this.requireAuthenticated(params.cwd);
    const session = await this.createSession(params.cwd, params.additionalDirectories);
    if (client) {
      // Clients (e.g. Zed) only learn this sessionId from the `session/new`
      // response and register it then; a notification sent earlier targets a
      // session the client doesn't recognize yet and gets silently dropped.
      // Defer past the response so it's on the wire second, not first.
      deferAfterResponse(() => this.notifyAvailableCommandsV1(client, session.sessionId));
    }
    return {
      sessionId: session.sessionId,
      modes: sessionModeState(session.agy.config.mode),
      configOptions: sessionConfigOptionsV1(session)
    };
  }

  async newSessionV2(
    params: V2NewSessionRequest,
    client?: V2AgentContext
  ): Promise<V2NewSessionResponse> {
    await this.requireAuthenticated(params.cwd);
    const session = await this.createSession(params.cwd, params.additionalDirectories);
    // Draft v2 has no native session/set_mode surface; mode is the config option only.
    if (client) {
      // See newSessionV1: must not resolve before the response is sent, or
      // the client drops it as a notification for an unknown session.
      deferAfterResponse(() => this.notifyAvailableCommandsV2(client, session.sessionId));
    }
    return {
      sessionId: session.sessionId,
      configOptions: sessionConfigOptionsV2(session)
    };
  }

  async listSessions(params: ListSessionsRequest = {}): Promise<ListSessionsResponse> {
    const listed = await this.#store.list({ cwd: params.cwd ?? null });
    return {
      sessions: listed.map((entry) => ({
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        additionalDirectories: entry.additionalDirectories,
        updatedAt: entry.updatedAt
      }))
    };
  }

  /**
   * v1 `session/load`: reconstruct a previously persisted session and replay its
   * agy conversation history (if bound to one) before returning.
   */
  async loadSession(params: LoadSessionRequest, client: V1AgentContext): Promise<LoadSessionResponse> {
    await this.requireAuthenticated(params.cwd);
    const { session, cwd, stored } = await this.reloadSession(
      params.sessionId,
      params.cwd,
      params.additionalDirectories
    );

    if (stored.conversationId) {
      await this.replayConversation(params.sessionId, session, stored.conversationId, cwd, async (update) => {
        await client.notify(v1.methods.client.session.update, {
          sessionId: params.sessionId,
          update: sessionUpdateToV1(update)
        });
      });
    }

    await this.notifyAvailableCommandsV1(client, params.sessionId);

    return {
      modes: sessionModeState(session.agy.config.mode),
      configOptions: sessionConfigOptionsV1(session)
    };
  }

  /** v1 `session/resume`: reattach without replaying history. */
  async resumeSessionV1(
    params: V1ResumeSessionRequest,
    client?: V1AgentContext
  ): Promise<V1ResumeSessionResponse> {
    await this.requireAuthenticated(params.cwd);
    const { session } = await this.reloadSession(params.sessionId, params.cwd, params.additionalDirectories);
    if (client) {
      await this.notifyAvailableCommandsV1(client, params.sessionId);
    }
    return {
      modes: sessionModeState(session.agy.config.mode),
      configOptions: sessionConfigOptionsV1(session)
    };
  }

  /**
   * v2 `session/resume`: optional `replayFrom: { type: "start" }` replaces v1
   * `session/load`. Omitting `replayFrom` reattaches without history.
   */
  async resumeSessionV2(
    params: V2ResumeSessionRequest,
    client: V2AgentContext
  ): Promise<V2ResumeSessionResponse> {
    await this.requireAuthenticated(params.cwd);
    const { session, cwd, stored } = await this.reloadSession(
      params.sessionId,
      params.cwd,
      params.additionalDirectories
    );

    const replayFrom = params.replayFrom ?? null;
    if (replayFrom != null) {
      if (replayFrom.type !== "start") {
        throw new Error(`Unsupported replay cursor: ${String((replayFrom as { type?: string }).type)}`);
      }
      if (stored.conversationId) {
        await this.replayConversation(params.sessionId, session, stored.conversationId, cwd, async (update) => {
          for (const v2Update of expandSessionUpdateToV2(update)) {
            await client.notify(v2.methods.client.session.update, {
              sessionId: params.sessionId,
              update: v2Update
            });
          }
        });
      }
    }

    await this.notifyAvailableCommandsV2(client, params.sessionId);

    return { configOptions: sessionConfigOptionsV2(session) };
  }

  async setConfigOptionV1(
    params: V1SetSessionConfigOptionRequest,
    client?: V1AgentContext
  ): Promise<V1SetSessionConfigOptionResponse> {
    const configId = params.configId;
    const previousMode = this.requireSession(params.sessionId).agy.config.mode;
    await this.applyConfigOption(params.sessionId, configId, readConfigValue(params));
    const session = this.requireSession(params.sessionId);

    // Keep native modes UI in sync when mode changes via config option.
    if (client && configId === MODE_CONFIG_ID && session.agy.config.mode !== previousMode) {
      await this.notifyCurrentModeUpdate(client, params.sessionId, session.agy.config.mode);
    }

    return { configOptions: sessionConfigOptionsV1(session) };
  }

  async setConfigOptionV2(
    params: V2SetSessionConfigOptionRequest
  ): Promise<V2SetSessionConfigOptionResponse> {
    await this.applyConfigOption(params.sessionId, params.configId, readConfigValue(params));
    // Draft v2 has no set_mode; the response carries the full option list.
    // Out-of-band `config_option_update` is emitted on the v1 set_mode path (outside
    // this RPC) so config UIs stay aligned with native modes.
    return { configOptions: sessionConfigOptionsV2(this.requireSession(params.sessionId)) };
  }

  /**
   * v1 `session/set_mode`: mirrors the `mode` config option onto agy `--mode`.
   * Pushes `config_option_update` so clients that only watch config options stay
   * aligned (set_mode is outside set_config_option).
   */
  async setSessionMode(
    params: SetSessionModeRequest,
    client: V1AgentContext
  ): Promise<SetSessionModeResponse> {
    const previousMode = this.requireSession(params.sessionId).agy.config.mode;
    await this.applyConfigOption(params.sessionId, MODE_CONFIG_ID, params.modeId);
    const session = this.requireSession(params.sessionId);
    const mode = session.agy.config.mode;

    if (mode !== previousMode) {
      await this.notifyCurrentModeUpdate(client, params.sessionId, mode);
      await this.notifyConfigOptionUpdateV1(client, params.sessionId, session);
    }

    return {};
  }

  private async notifyCurrentModeUpdate(
    client: V1AgentContext,
    sessionId: string,
    mode: SessionModeId
  ): Promise<void> {
    await client.notify(v1.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: mode
      }
    });
  }

  private async notifyConfigOptionUpdateV1(
    client: V1AgentContext,
    sessionId: string,
    session: SessionState
  ): Promise<void> {
    await client.notify(v1.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: sessionConfigOptionsV1(session)
      }
    });
  }

  private async notifyAvailableCommandsV1(client: V1AgentContext, sessionId: string): Promise<void> {
    await client.notify(v1.methods.client.session.update, {
      sessionId,
      update: sessionUpdateToV1(availableCommandsUpdate())
    });
  }

  private async notifyAvailableCommandsV2(client: V2AgentContext, sessionId: string): Promise<void> {
    await client.notify(v2.methods.client.session.update, {
      sessionId,
      update: sessionUpdateToV2(availableCommandsUpdate())
    });
  }

  private async notifyConfigOptionUpdateV2(
    client: V2AgentContext,
    sessionId: string,
    session: SessionState
  ): Promise<void> {
    await client.notify(v2.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: sessionConfigOptionsV2(session)
      }
    });
  }

  /**
   * Honor curated ACP slash commands that map onto session config (mode / model /
   * reasoningEffort). Returns true when the prompt was fully handled without
   * spawning agy. Unknown or non-slash prompts return false (pass through).
   */
  private async applyCuratedSlashCommand(
    sessionId: string,
    promptText: string,
    notify: {
      modeChanged?: (mode: SessionModeId) => Promise<void>;
      configChanged: () => Promise<void>;
    }
  ): Promise<boolean> {
    const parsed = parseSlashCommand(promptText);
    if (!parsed) return false;

    const result = interpretSlashCommand(parsed);
    if (result.kind === "pass") return false;
    if (result.kind === "error") {
      throw new Error(result.message);
    }

    const session = this.requireSession(sessionId);
    let value = result.value;
    if (result.configId === MODEL_CONFIG_ID) {
      const resolved = resolveModelValue(value, session.catalog);
      if (!resolved) {
        throw new Error(`Unknown model: ${value}`);
      }
      value = resolved;
    }

    const previousMode = session.agy.config.mode;
    await this.applyConfigOption(sessionId, result.configId, value);
    const after = this.requireSession(sessionId);

    if (
      result.configId === MODE_CONFIG_ID &&
      after.agy.config.mode !== previousMode &&
      notify.modeChanged
    ) {
      await notify.modeChanged(after.agy.config.mode);
    }
    await notify.configChanged();
    return true;
  }

  /**
   * v1 prompt lifecycle: response carries stopReason after the full turn.
   */
  async promptV1(
    params: V1PromptRequest,
    client: V1AgentContext,
    signal?: AbortSignal
  ): Promise<V1PromptResponse> {
    const session = this.requireSession(params.sessionId);
    if (session.activePrompt) {
      throw new Error(`Session already has an active prompt: ${params.sessionId}`);
    }

    const prompt = await contentBlocksToPrompt(params.prompt, session.cwd);

    // Curated slash commands → config options; do not spawn agy for those.
    const handled = await this.applyCuratedSlashCommand(params.sessionId, prompt, {
      modeChanged: (mode) => this.notifyCurrentModeUpdate(client, params.sessionId, mode),
      configChanged: async () => {
        await this.notifyConfigOptionUpdateV1(
          client,
          params.sessionId,
          this.requireSession(params.sessionId)
        );
      }
    });
    if (handled) {
      return { stopReason: signal?.aborted ? "cancelled" : "end_turn" };
    }

    session.activePrompt = true;
    const cancelPrompt = () => {
      session.agy.cancel().catch(() => {
        // The prompt loop will surface process failures through its own result.
      });
    };
    signal?.addEventListener("abort", cancelPrompt, { once: true });

    try {
      const outcome = await session.agy.prompt(prompt, async (update) => {
        await client.notify(v1.methods.client.session.update, {
          sessionId: params.sessionId,
          update: sessionUpdateToV1(update)
        });
      }, async (toolCall, { toolName }) => {
        if (signal?.aborted) return "cancelled";
        const { sessionUpdate: _discriminator, ...requestToolCall } = toolCall as unknown as Record<string, unknown>;
        const response = await racePermissionCancellation(client.request(v1.methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: requestToolCall as v1.ToolCallUpdate,
          options: permissionOptions(toolCall, toolName)
        }), signal);
        return selectedPermission(response, signal);
      }, this.clientFileSystemV1(client, params.sessionId));
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

  /**
   * v2 prompt lifecycle: respond `{}` immediately on acceptance. Foreground
   * progress and stopReason arrive as `state_update` notifications.
   */
  async promptV2(params: V2PromptRequest, client: V2AgentContext): Promise<V2PromptResponse> {
    const session = this.requireSession(params.sessionId);
    if (session.activePrompt) {
      throw new Error(`Session already has an active prompt: ${params.sessionId}`);
    }

    // Content block shapes are compatible at runtime; v1/v2 TS types diverge on open enums.
    const promptText = await contentBlocksToPrompt(params.prompt as v1.ContentBlock[], session.cwd);
    session.activePrompt = true;
    const controller = new AbortController();
    session.promptAbort = controller;

    // Queue the empty acceptance response before any session/update from the turn.
    // Work starts on the next event-loop task (see dual-version-agent example).
    const responseQueued = new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    void responseQueued
      .then(() => this.runV2PromptTurn(params, client, session, promptText, controller.signal))
      .catch((error) => {
        console.error(`[agy-acp] v2 prompt turn failed: ${(error as Error).message}`);
      })
      .finally(() => {
        if (session.promptAbort === controller) {
          session.promptAbort = undefined;
        }
        session.activePrompt = false;
      });

    return {};
  }

  async cancel(params: { sessionId: string }): Promise<void> {
    const session = this.#sessions.get(params.sessionId);
    session?.promptAbort?.abort();
    await session?.agy.cancel();
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.#sessions.get(params.sessionId);
    this.#sessions.delete(params.sessionId);
    session?.promptAbort?.abort();
    await session?.agy.close();
    return {};
  }

  private async createSession(
    requestedCwd: string | undefined,
    requestedDirs: string[] | undefined
  ): Promise<SessionState> {
    const cwd = requestedCwd || process.cwd();
    const additionalDirectories = dedupe(requestedDirs ?? []);
    const sessionId = randomUUID();
    const session = await this.buildSession(cwd, additionalDirectories, null);
    session.sessionId = sessionId;
    this.#sessions.set(sessionId, session);
    await this.persistSession(sessionId, session);
    return session;
  }

  private async applyConfigOption(sessionId: string, configId: string, value: unknown): Promise<void> {
    const session = this.requireSession(sessionId);
    if (configId === MODE_CONFIG_ID) {
      if (typeof value !== "string" || !isSessionModeId(value)) {
        throw new Error(`Mode must be one of: ${SESSION_MODE_IDS.join(", ")}`);
      }
      session.agy.setMode(value);
      await this.persistSession(sessionId, session);
      return;
    }

    if (configId === MODEL_CONFIG_ID) {
      if (typeof value !== "string") {
        throw new Error("Model config value must be a string");
      }
      if (!session.catalog.baseModels().includes(value)) {
        throw new Error(`Unknown model: ${value}`);
      }

      session.selectedBaseModel = value;
      session.selectedReasoningEffort = defaultReasoningEffortForBase(value, session.catalog);
      applyModelSelection(
        session.agy,
        session.selectedBaseModel,
        session.selectedReasoningEffort,
        session.catalog
      );
      await this.persistSession(sessionId, session);
      return;
    }

    if (configId === REASONING_EFFORT_CONFIG_ID) {
      if (typeof value !== "string") {
        throw new Error("reasoningEffort config value must be a string");
      }
      const allowedEfforts = reasoningEffortValues(session.selectedBaseModel, session.catalog);
      if (!allowedEfforts.includes(value)) {
        throw new Error(`Unknown reasoningEffort: ${value}`);
      }

      session.selectedReasoningEffort = value;
      applyModelSelection(
        session.agy,
        session.selectedBaseModel,
        session.selectedReasoningEffort,
        session.catalog
      );
      await this.persistSession(sessionId, session);
      return;
    }

    throw new Error(`Unknown config option: ${configId}`);
  }

  private async replayConversation(
    sessionId: string,
    session: SessionState,
    conversationId: string,
    cwd: string,
    emit: (update: v1.SessionUpdate) => Promise<void>
  ): Promise<void> {
    const replay = this.#replayCache.get(session.agy.config.conversationsDir, conversationId, {
      skipNarration: false,
      cwd
    });
    if (!replay) return;
    for (const update of replay.updates) {
      await emit(update);
    }
    void sessionId;
  }

  private async runV2PromptTurn(
    params: V2PromptRequest,
    client: V2AgentContext,
    session: SessionState,
    promptText: string,
    signal: AbortSignal
  ): Promise<void> {
    const notify = async (update: v2.SessionUpdate) => {
      await client.notify(v2.methods.client.session.update, {
        sessionId: params.sessionId,
        update
      });
    };

    const userMessageId = randomUUID();
    try {
      signal.throwIfAborted();

      // User message acknowledgment — source of truth for agent-owned messageId.
      await notify({
        sessionUpdate: "user_message",
        messageId: userMessageId,
        content: params.prompt as v2.ContentBlock[]
      });

      signal.throwIfAborted();
      await notify({ sessionUpdate: "state_update", state: "running" });

      // Curated slash commands → config options (no agy spawn).
      const slashHandled = await this.applyCuratedSlashCommand(params.sessionId, promptText, {
        configChanged: async () => {
          await this.notifyConfigOptionUpdateV2(client, params.sessionId, this.requireSession(params.sessionId));
        }
      });
      if (slashHandled) {
        await notify({
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: signal.aborted ? "cancelled" : "end_turn"
        });
        return;
      }

      const cancelPrompt = () => {
        session.agy.cancel().catch(() => {});
      };
      signal.addEventListener("abort", cancelPrompt, { once: true });

      try {
        const outcome = await session.agy.prompt(promptText, async (update) => {
          for (const v2Update of expandSessionUpdateToV2(update)) {
            await notify(v2Update);
          }
        }, async (toolCall, { toolName }) => {
          if (signal.aborted) return "cancelled";
          // Permission subject uses the tool_call_update only (skip terminal_update).
          const expanded = expandSessionUpdateToV2(toolCall);
          const converted = (expanded.find((item) => {
            const kind = (item as unknown as { sessionUpdate?: string }).sessionUpdate;
            return kind === "tool_call_update" || kind === "tool_call";
          }) ?? sessionUpdateToV2(toolCall)) as unknown as Record<string, unknown>;
          const { sessionUpdate: _discriminator, ...requestToolCall } = converted;
          const response = await racePermissionCancellation(client.request(v2.methods.client.session.requestPermission, {
            sessionId: params.sessionId,
            title: String(requestToolCall.title ?? "Permission required"),
            subject: { type: "tool_call", toolCall: requestToolCall as v2.ToolCallUpdate },
            options: permissionOptions(toolCall, toolName)
          }), signal);
          return selectedPermission(response, signal);
        });
        await this.persistSession(params.sessionId, session);

        const stopReason =
          outcome.stopReason === "cancelled" || signal.aborted ? "cancelled" : "end_turn";
        await notify({
          sessionUpdate: "state_update",
          state: "idle",
          stopReason
        });
      } finally {
        signal.removeEventListener("abort", cancelPrompt);
      }
    } catch (error) {
      await this.persistSession(params.sessionId, session).catch(() => {});
      if (signal.aborted) {
        await notify({
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "cancelled"
        });
        return;
      }
      // Surface a failed turn as idle so the client is not left in `running`.
      await notify({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn"
      });
      throw error;
    }
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

  /** Build a fresh session bound to `cwd` + ACP `additionalDirectories`. */
  private async buildSession(
    cwd: string,
    additionalDirectories: string[],
    stored: StoredSession | null
  ): Promise<SessionState> {
    const config = configFromEnv({ cwd, additionalDirectories, env: this.#env, argv: this.#argv });
    const modelOptions = await this.modelOptionsForConfig(config);
    const catalog = buildModelCatalog(modelOptions);
    const agy = await this.#backend.startSession(config);

    if (stored?.conversationId) {
      agy.restoreConversation(stored.conversationId, stored.lastStepIdx);
    }

    const selection = stored
      ? restoredModelSelection(stored, catalog)
      : initialModelSelection(config.model, catalog);
    applyModelSelection(agy, selection.baseModel, selection.reasoningEffort, catalog);
    if (stored?.mode && isSessionModeId(stored.mode)) {
      agy.setMode(stored.mode);
    }

    return {
      sessionId: "", // set by the caller once the ACP session id is known
      cwd,
      additionalDirectories,
      agy,
      catalog,
      selectedBaseModel: selection.baseModel,
      selectedReasoningEffort: selection.reasoningEffort,
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
    const additionalDirectories = dedupe(
      requestedDirs ?? stored.additionalDirectories
    );

    const session = await this.buildSession(cwd, additionalDirectories, stored);
    session.sessionId = sessionId;
    this.#sessions.set(sessionId, session);
    return { session, cwd, stored };
  }

  private sessionRecord(session: SessionState): StoredSession {
    return {
      cwd: session.cwd,
      additionalDirectories: session.additionalDirectories,
      conversationId: session.agy.conversationId,
      lastStepIdx: session.agy.lastStepIdx,
      model: session.selectedBaseModel,
      reasoningEffort: session.selectedReasoningEffort,
      mode: session.agy.config.mode,
      updatedAt: new Date().toISOString()
    };
  }

  private persistSession(sessionId: string, session: SessionState): Promise<void> {
    return this.#store.persist(sessionId, this.sessionRecord(session));
  }
}

/** ACP v1 agent app (stable protocol). */
export function createAcpApp(options: AcpAgentOptions = {}): V1AgentApp {
  const agent = new AcpAgent(options);
  return v1
    .agent({ name: "agy-acp" })
    .onRequest(v1.methods.agent.initialize, (ctx) => agent.initializeV1(ctx.params))
    .onRequest(v1.methods.agent.authenticate, (ctx) => agent.authenticate(ctx.params))
    .onRequest(v1.methods.agent.logout, (ctx) => agent.logout(ctx.params))
    .onRequest(v1.methods.agent.session.new, (ctx) => agent.newSessionV1(ctx.params, ctx.client))
    .onRequest(v1.methods.agent.session.list, (ctx) => agent.listSessions(ctx.params))
    .onRequest(v1.methods.agent.session.load, (ctx) => agent.loadSession(ctx.params, ctx.client))
    .onRequest(v1.methods.agent.session.resume, (ctx) => agent.resumeSessionV1(ctx.params, ctx.client))
    .onRequest(v1.methods.agent.session.setMode, (ctx) => agent.setSessionMode(ctx.params, ctx.client))
    .onRequest(v1.methods.agent.session.setConfigOption, (ctx) =>
      agent.setConfigOptionV1(ctx.params, ctx.client)
    )
    .onRequest(v1.methods.agent.session.prompt, (ctx) => agent.promptV1(ctx.params, ctx.client, ctx.signal))
    .onRequest(v1.methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
    .onNotification(v1.methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params));
}

/**
 * Experimental draft ACP v2 agent app.
 * Prefer {@link createDualAcpApp} / {@link runAcp} so v1 clients still work.
 */
export function createAcpV2App(options: AcpAgentOptions = {}): V2AgentApp {
  const agent = new AcpAgent(options);
  return v2
    .agent({ name: "agy-acp" })
    .onRequest(v2.methods.agent.initialize, (ctx) => agent.initializeV2(ctx.params))
    .onRequest(v2.methods.agent.auth.login, (ctx) => agent.loginAuth(ctx.params))
    .onRequest(v2.methods.agent.auth.logout, (ctx) => agent.logoutAuth(ctx.params))
    .onRequest(v2.methods.agent.session.new, (ctx) => agent.newSessionV2(ctx.params, ctx.client))
    .onRequest(v2.methods.agent.session.list, (ctx) => agent.listSessions(ctx.params))
    .onRequest(v2.methods.agent.session.resume, (ctx) => agent.resumeSessionV2(ctx.params, ctx.client))
    .onRequest(v2.methods.agent.session.setConfigOption, (ctx) => agent.setConfigOptionV2(ctx.params))
    .onRequest(v2.methods.agent.session.prompt, (ctx) => agent.promptV2(ctx.params, ctx.client))
    .onRequest(v2.methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
    .onNotification(v2.methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params));
}

/**
 * Dual-version agent connector: negotiates ACP v1 or experimental draft v2 from
 * the client's `initialize.protocolVersion`.
 */
export function createDualAcpApp(options: AcpAgentOptions = {}): v2.AgentProtocolRouter {
  return v2.agentProtocolRouter().withV1(createAcpApp(options)).withV2(createAcpV2App(options));
}

export function runAcp(options: AcpAgentOptions = {}) {
  const stdout = (options.stdout ?? process.stdout) as Writable;
  const stdin = (options.stdin ?? process.stdin) as Readable;
  // v1 ndJsonStream is sufficient: framing is shared; the router peeks initialize.
  const stream = v1.ndJsonStream(
    Writable.toWeb(stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(stdin) as ReadableStream<Uint8Array>
  );
  return createDualAcpApp(options).connect(stream);
}

export { contentBlocksToPrompt, contentBlocksToText } from "./content/index.js";

function selectedPermission(response: unknown, signal?: AbortSignal): PermissionChoice | "cancelled" {
  if (signal?.aborted || !response || typeof response !== "object") return "cancelled";
  const outcome = (response as { outcome?: unknown }).outcome;
  if (!outcome || typeof outcome !== "object" || (outcome as { outcome?: string }).outcome !== "selected") return "cancelled";
  const id = (outcome as { optionId?: string }).optionId;
  if (typeof id !== "string" || !id.trim()) return "cancelled";
  // Standard ACP ids, legacy agy-* ids, and ask_question option ids.
  if (
    id === "allow-once" ||
    id === "allow-always" ||
    id === "reject-once" ||
    id === "agy-allow-once" ||
    id === "agy-allow-conversation" ||
    id === "agy-allow-settings" ||
    id === "agy-reject-once" ||
    id === "agy-q-skip" ||
    /^agy-q-\d+$/.test(id)
  ) {
    return id;
  }
  return "cancelled";
}

async function racePermissionCancellation<T>(request: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return request;
  if (signal.aborted) return null;
  // A client may eventually reject a request abandoned because the turn was
  // cancelled. Attach a handler now so that rejection is never unhandled.
  const guarded = request.then((value) => value, (error) => {
    if (signal.aborted) return null;
    throw error;
  });
  let abort!: () => void;
  const cancelled = new Promise<null>((resolve) => {
    abort = () => resolve(null);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([guarded, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

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
    const { agyBase, base, reasoningEffort, displayBase } = splitModelEntry(entry);
    if (!effectsByBase.has(base)) {
      baseOrder.push(base);
      effectsByBase.set(base, []);
      agyBaseBySlug.set(base, agyBase);
      displayNameBySlug.set(base, displayBase);
    }
    if (reasoningEffort) {
      const effects = effectsByBase.get(base)!;
      if (!effects.includes(reasoningEffort)) {
        effects.push(reasoningEffort);
      }
    }
  }

  return {
    entries: uniqueEntries,
    baseModels: () => baseOrder,
    effortsFor: (baseModel: string) => effectsByBase.get(baseModel) ?? [],
    resolve: (baseModel: string, reasoningEffort: string) => {
      const resolved = uniqueEntries.find((entry) => {
        const parsed = splitModelEntry(entry);
        return parsed.base === baseModel && parsed.reasoningEffort === reasoningEffort;
      });
      if (!resolved) {
        throw new Error(`Unknown model selection: ${baseModel} (${reasoningEffort})`);
      }
      return resolved;
    },
    split: (fullModel: string) => {
      const { base, reasoningEffort } = splitModelEntry(fullModel);
      return { base, reasoningEffort };
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

/** Shared labels/descriptions for config option `mode` and native ACP session modes. */
const AGY_MODE_OPTIONS: ReadonlyArray<{
  value: SessionModeId;
  name: string;
  description: string;
}> = [
  {
    value: "default",
    name: "Default",
    description: "Request review before file writes (agy default; omits --mode)."
  },
  {
    value: "accept-edits",
    name: "Accept Edits",
    description: "Apply file edits without interactive write review (agy --mode accept-edits)."
  },
  {
    value: "plan",
    name: "Plan",
    description: "Plan-oriented execution (agy --mode plan)."
  }
];

/** Native ACP session mode state (v1 `modes` on new/load/resume). Same ids as config `mode`. */
export function sessionModeState(mode: SessionModeId): SessionModeState {
  return {
    currentModeId: mode,
    availableModes: AGY_MODE_OPTIONS.map((option) => ({
      id: option.value,
      name: option.name,
      description: option.description
    }))
  };
}

export function modeConfigOption(mode: SessionModeId): V1SessionConfigOption {
  return {
    id: MODE_CONFIG_ID,
    name: "Mode",
    description:
      "agy execution mode (--mode). Default reviews writes; Accept Edits applies file changes; Plan focuses on planning.",
    category: "mode",
    type: "select",
    currentValue: mode,
    options: AGY_MODE_OPTIONS.map((option) => ({
      value: option.value,
      name: option.name,
      description: option.description
    }))
  };
}

export function modelConfigOption(selectedBaseModel: string, catalog: ModelCatalog): V1SessionConfigOption {
  return {
    id: MODEL_CONFIG_ID,
    name: "Model",
    description: "ACP model slug passed to agy --model (reasoningEffort is selected separately).",
    category: "model",
    type: "select",
    currentValue: selectedBaseModel,
    options: catalog.baseModels().map((slug) => ({
      value: slug,
      name: catalog.displayName(slug)
    }))
  };
}

export function reasoningEffortConfigOption(
  selectedBaseModel: string,
  selectedReasoningEffort: string,
  catalog: ModelCatalog
): V1SessionConfigOption {
  return {
    id: REASONING_EFFORT_CONFIG_ID,
    name: "Reasoning Effort",
    description: "Value for agy --effort (low | medium | high) for the selected model.",
    category: "thought_level",
    type: "select",
    currentValue: selectedReasoningEffort,
    options: reasoningEffortOptions(selectedBaseModel, catalog)
  };
}

function sessionConfigOptionsV1(session: SessionState): V1SessionConfigOption[] {
  return [
    modeConfigOption(session.agy.config.mode),
    modelConfigOption(session.selectedBaseModel, session.catalog),
    reasoningEffortConfigOption(
      session.selectedBaseModel,
      session.selectedReasoningEffort,
      session.catalog
    )
  ];
}

/** v2 renames config option `id` → `configId`. */
function sessionConfigOptionsV2(session: SessionState): V2SessionConfigOption[] {
  return sessionConfigOptionsV1(session).map(v1ConfigOptionToV2);
}

function v1ConfigOptionToV2(option: V1SessionConfigOption): V2SessionConfigOption {
  const { id, ...rest } = option as V1SessionConfigOption & { id: string };
  return { ...rest, configId: id } as V2SessionConfigOption;
}

function readConfigValue(params: { value?: unknown; type?: string }): unknown {
  return params.value;
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
  reasoningEffort?: string;
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
      reasoningEffort: legacyEffort[1].toLowerCase()
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
      reasoningEffort: slugEffort[2].toLowerCase()
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

function reasoningEffortOptions(
  selectedBaseModel: string,
  catalog: ModelCatalog
): Extract<V1SessionConfigOption, { type: "select" }>["options"] {
  const effects = catalog.effortsFor(selectedBaseModel);
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
    name: reasoningEffortDisplayName(effect)
  }));
}

function reasoningEffortDisplayName(value: string): string {
  const labels: Record<string, string> = {
    low: "Low",
    medium: "Medium",
    high: "High"
  };
  return labels[value] ?? value;
}

function reasoningEffortValues(selectedBaseModel: string, catalog: ModelCatalog): string[] {
  return reasoningEffortOptions(selectedBaseModel, catalog)
    .map((option) => ("value" in option ? option.value : undefined))
    .filter((value): value is string => value !== undefined);
}

function defaultReasoningEffortForBase(selectedBaseModel: string, catalog: ModelCatalog): string {
  const effects = catalog.effortsFor(selectedBaseModel);
  return effects[0] ?? NO_REASONING_VALUE;
}

function initialModelSelection(
  configuredModel: string | undefined,
  catalog: ModelCatalog
): { baseModel: string; reasoningEffort: string } {
  if (!configuredModel) {
    const [firstBaseModel] = catalog.baseModels();
    if (!firstBaseModel) {
      throw new Error("No models available. Ensure agy models succeeds.");
    }
    return {
      baseModel: firstBaseModel,
      reasoningEffort: defaultReasoningEffortForBase(firstBaseModel, catalog)
    };
  }

  const { base, reasoningEffort } = catalog.split(configuredModel);
  const effects = catalog.effortsFor(base);
  if (effects.length === 0) {
    return {
      baseModel: base,
      reasoningEffort: NO_REASONING_VALUE
    };
  }

  return {
    baseModel: base,
    reasoningEffort: reasoningEffort && effects.includes(reasoningEffort)
      ? reasoningEffort
      : effects[0]
  };
}

/** Like `initialModelSelection`, but for a persisted choice: falls back to the
 *  default selection if the model no longer appears in the current catalog. */
function restoredModelSelection(
  stored: StoredSession,
  catalog: ModelCatalog
): { baseModel: string; reasoningEffort: string } {
  const baseModel = normalizeStoredBaseModel(stored.model, catalog);
  if (!baseModel) {
    return initialModelSelection(undefined, catalog);
  }
  const effects = catalog.effortsFor(baseModel);
  if (effects.length === 0) {
    return { baseModel, reasoningEffort: NO_REASONING_VALUE };
  }
  return {
    baseModel,
    reasoningEffort: normalizeStoredReasoningEffort(stored.reasoningEffort, effects)
  };
}

function normalizeStoredBaseModel(modelId: string, catalog: ModelCatalog): string | undefined {
  if (catalog.baseModels().includes(modelId)) {
    return modelId;
  }
  return catalog.slugForAgyBase(modelId);
}

function normalizeStoredReasoningEffort(storedEffect: string, effects: string[]): string {
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
  selectedReasoningEffort: string,
  catalog: ModelCatalog
): void {
  // agy ≥1.1.5: --model is the base (slug or legacy display base), --effort is separate.
  agy.setModel(catalog.agyBaseName(selectedBaseModel));

  const effects = catalog.effortsFor(selectedBaseModel);
  if (effects.length === 0) {
    agy.setEffort(undefined);
    return;
  }

  if (selectedReasoningEffort === NO_REASONING_VALUE || !effects.includes(selectedReasoningEffort)) {
    agy.setEffort(effects[0]);
    return;
  }

  agy.setEffort(selectedReasoningEffort);
}
