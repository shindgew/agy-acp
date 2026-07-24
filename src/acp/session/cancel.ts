// ACP session/cancel (notification): abort the active prompt turn, if any.
// Docs: https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation

import type { SessionState } from "./types.js";

export async function handleCancel(sessionId: string, sessions: Map<string, SessionState>): Promise<void> {
  const session = sessions.get(sessionId);
  session?.promptAbort?.abort();
  await session?.agy.cancel();
}
