// ACP session/new, session/load, session/resume: build and reload agy-backed sessions.
// Docs: https://agentclientprotocol.com/protocol/v1/session-setup

import { randomUUID } from "node:crypto";
import type * as v1 from "@agentclientprotocol/sdk";
import {
  configFromEnv,
  isSessionModeId,
  type AgyCliBackend,
  type AgyCliConfig
} from "../../agy/cli.js";
import type { ReplayCache } from "../../agy/db/replay.js";
import { buildModelCatalog } from "../../agy/model/catalog.js";
import { applyModelSelection, initialModelSelection, restoredModelSelection } from "../../agy/model/selection.js";
import type { SessionStore, StoredSession } from "./store.js";
import type { SessionState } from "./types.js";

export interface SessionBuildDeps {
  env: NodeJS.ProcessEnv;
  argv: string[];
  backend: AgyCliBackend;
  getModelOptions(config: AgyCliConfig): Promise<string[]>;
}

/** Build a fresh session bound to `cwd` + ACP `additionalDirectories`. */
export async function buildSession(
  cwd: string,
  additionalDirectories: string[],
  stored: StoredSession | null,
  deps: SessionBuildDeps
): Promise<SessionState> {
  const config = configFromEnv({ cwd, additionalDirectories, env: deps.env, argv: deps.argv });
  const modelOptions = await deps.getModelOptions(config);
  const catalog = buildModelCatalog(modelOptions);
  const agy = await deps.backend.startSession(config);

  if (stored?.conversationId) {
    agy.restoreConversation(stored.conversationId, stored.lastStepIdx);
  }

  const selection = stored
    ? restoredModelSelection(stored.model, stored.reasoningEffort, catalog)
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

/** Register a session in the active-sessions map, evicting idle sessions past the capacity limit. */
export async function registerSession(
  sessionId: string,
  session: SessionState,
  sessions: Map<string, SessionState>,
  maxActiveSessions: number
): Promise<void> {
  const replaced = sessions.get(sessionId);
  if (replaced && replaced !== session) {
    sessions.delete(sessionId);
    replaced.promptAbort?.abort();
    await replaced.agy.close().catch(() => {});
  }

  while (sessions.size >= maxActiveSessions) {
    const candidate = [...sessions].find(([, current]) => !current.activePrompt);
    if (!candidate) break;
    const [evictedId, evicted] = candidate;
    sessions.delete(evictedId);
    await evicted.agy.close().catch((error) => {
      console.error(
        `[agy-acp] WARN: failed to close evicted session ${evictedId}: ${(error as Error).message}`
      );
    });
  }
  sessions.set(sessionId, session);
}

export async function createSession(
  requestedCwd: string | undefined,
  requestedDirs: string[] | undefined,
  deps: SessionBuildDeps & {
    sessions: Map<string, SessionState>;
    maxActiveSessions: number;
    persistSession(sessionId: string, session: SessionState): Promise<void>;
  }
): Promise<SessionState> {
  const cwd = requestedCwd || process.cwd();
  const additionalDirectories = dedupe(requestedDirs ?? []);
  const sessionId = randomUUID();
  const session = await buildSession(cwd, additionalDirectories, null, deps);
  session.sessionId = sessionId;
  await registerSession(sessionId, session, deps.sessions, deps.maxActiveSessions);
  await deps.persistSession(sessionId, session);
  return session;
}

/** Shared reconstruction for `session/load` and `session/resume`: restore a
 *  persisted session binding and re-register it in memory. */
export async function reloadSession(
  sessionId: string,
  requestedCwd: string | undefined,
  requestedDirs: string[] | undefined,
  deps: SessionBuildDeps & {
    store: SessionStore;
    sessions: Map<string, SessionState>;
    maxActiveSessions: number;
  }
): Promise<{ session: SessionState; cwd: string; stored: StoredSession }> {
  const stored = await deps.store.restore(sessionId);
  if (!stored) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  const cwd = requestedCwd || stored.cwd;
  const additionalDirectories = dedupe(requestedDirs ?? stored.additionalDirectories);

  const session = await buildSession(cwd, additionalDirectories, stored, deps);
  session.sessionId = sessionId;
  await registerSession(sessionId, session, deps.sessions, deps.maxActiveSessions);
  return { session, cwd, stored };
}

export function sessionRecord(session: SessionState): StoredSession {
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

export function persistSession(
  store: SessionStore,
  sessionId: string,
  session: SessionState
): Promise<void> {
  return store.persist(sessionId, sessionRecord(session));
}

/** Replay a persisted conversation's session updates (used by `session/load` and
 *  `session/resume` with `replayFrom: { type: "start" }`). */
export async function replayConversation(
  replayCache: ReplayCache,
  session: SessionState,
  conversationId: string,
  cwd: string,
  emit: (update: v1.SessionUpdate) => Promise<void>
): Promise<void> {
  const replay = replayCache.get(session.agy.config.conversationsDir, conversationId, {
    skipNarration: false,
    cwd
  });
  if (!replay) return;
  for (const update of replay.updates) {
    await emit(update);
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
