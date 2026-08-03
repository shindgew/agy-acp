// ACP session/delete logic: purge persisted session state and clean up active session resources.
// Docs: https://agentclientprotocol.com/protocol/v1/session-delete

import type { DeleteSessionRequest, DeleteSessionResponse } from "@agentclientprotocol/sdk";
import type { SessionStore } from "./store.js";
import type { SessionState } from "./types.js";
import { cancelQueuedPrompts } from "./cancel.js";
import { wakePromptIdleWaiters } from "./prompt.js";

export interface SessionDeleteTarget {
  promptAbort?: AbortController | null;
  agy: { close(): Promise<void> };
}

/**
 * Handle `session/delete` for an active or persisted session:
 * 1. Aborts any active prompt in progress.
 * 2. Closes the agy backend process for this session.
 * 3. Removes the session binding from the SessionStore.
 */
export async function handleDeleteSession(
  params: DeleteSessionRequest,
  activeSessions: Map<string, SessionDeleteTarget>,
  store: SessionStore
): Promise<DeleteSessionResponse> {
  const session = activeSessions.get(params.sessionId);
  activeSessions.delete(params.sessionId);
  if (session) {
    (session as SessionState).closed = true;
    // Unblock any steer waiter before teardown so it observes `closed`.
    wakePromptIdleWaiters(session as SessionState);
    session.promptAbort?.abort();
    cancelQueuedPrompts(session as SessionState);
  }
  await session?.agy.close();
  await store.delete(params.sessionId);
  return {};
}
