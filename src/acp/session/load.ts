// ACP session/load: reconstruct a previously persisted session and replay its
// agy conversation history (if bound to one) before returning.
// Docs: https://agentclientprotocol.com/protocol/v1/session-setup#loading-sessions

import * as v1 from "@agentclientprotocol/sdk";
import type {
  AgentContext as V1AgentContext,
  LoadSessionRequest,
  LoadSessionResponse
} from "@agentclientprotocol/sdk";
import { sessionConfigOptionsV1 } from "./config-options.js";
import { sessionModeState } from "./modes.js";
import type { StoredSession } from "./store.js";
import type { SessionState } from "./types.js";
import { sessionUpdateToV1 } from "./update-wire.js";

export interface LoadSessionDeps {
  requireAuthenticated(cwd?: string): Promise<void>;
  reloadSession(
    sessionId: string,
    cwd: string | undefined,
    additionalDirectories: string[] | undefined
  ): Promise<{ session: SessionState; cwd: string; stored: StoredSession }>;
  replayConversation(
    session: SessionState,
    conversationId: string,
    cwd: string,
    emit: (update: v1.SessionUpdate) => Promise<void>
  ): Promise<void>;
  notifyAvailableCommandsV1(client: V1AgentContext, sessionId: string): Promise<void>;
}

export async function handleLoadSession(
  params: LoadSessionRequest,
  client: V1AgentContext,
  deps: LoadSessionDeps
): Promise<LoadSessionResponse> {
  await deps.requireAuthenticated(params.cwd);
  const { session, cwd, stored } = await deps.reloadSession(
    params.sessionId,
    params.cwd,
    params.additionalDirectories
  );

  if (stored.conversationId) {
    await deps.replayConversation(session, stored.conversationId, cwd, async (update) => {
      await client.notify(v1.methods.client.session.update, {
        sessionId: params.sessionId,
        update: sessionUpdateToV1(update)
      });
    });
  }

  await deps.notifyAvailableCommandsV1(client, params.sessionId);

  return {
    modes: sessionModeState(session.agy.config.mode),
    configOptions: sessionConfigOptionsV1(session)
  };
}
