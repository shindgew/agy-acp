// ACP session/cancel (notification): abort the active prompt turn, if any.
// Docs: https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation

import type { SessionState } from "./types.js";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";

export async function cancelQueuedPrompts(session: SessionState): Promise<void> {
  if (!Array.isArray(session.promptQueue)) return;
  const items = session.promptQueue.splice(0, session.promptQueue.length);
  for (const item of items) {
    if (item.version === "v1") {
      item.resolve({ stopReason: "cancelled" });
    } else {
      await item.client.notify(v2.methods.client.session.update, {
        sessionId: item.params.sessionId,
        update: {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "cancelled"
        }
      }).catch(() => {});
      item.controller.abort();
    }
  }
}

export async function handleCancel(
  sessionId: string,
  sessions: Map<string, SessionState>,
  meta?: Record<string, unknown> | null
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;

  const queuedPromptId = typeof meta?.["agy-acp/queuedPromptId"] === "string"
    ? meta["agy-acp/queuedPromptId"]
    : undefined;

  if (queuedPromptId) {
    const idx = session.promptQueue.findIndex((q) => q.id === queuedPromptId);
    if (idx >= 0) {
      const [removed] = session.promptQueue.splice(idx, 1);
      if (removed.version === "v1") {
        removed.resolve({ stopReason: "cancelled" });
      } else {
        await removed.client.notify(v2.methods.client.session.update, {
          sessionId: removed.params.sessionId,
          update: {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "cancelled"
          }
        }).catch(() => {});
        removed.controller.abort();
      }
      return;
    }
  }

  session.promptAbort?.abort();
  await session.agy.cancel();
}
