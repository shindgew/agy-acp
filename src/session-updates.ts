// Protocol-boundary conversion for session/update payloads.
//
// The db layer emits v1-shaped updates (with required messageIds on message
// chunks). v1 clients receive them as-is; v2 clients get the draft-v2 mapping
// (tool_call → tool_call_update, structured diffs, cancelled status, etc.).

import type { SessionUpdate as V1SessionUpdate } from "@agentclientprotocol/sdk";
import type { SessionUpdate as V2SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";

/** Absolute-path friendly git_patch text for a single-file text change. */
export function gitPatchForFile(
  path: string,
  oldText: string | null | undefined,
  newText: string
): string {
  const oldLines = (oldText ?? "").split("\n");
  const newLines = newText.split("\n");
  // Trailing empty line from split of empty string is fine for the line counts.
  if (oldText == null || oldText === "") {
    const body = newLines.map((line) => `+${line}`).join("\n");
    return [
      `diff --git ${path} ${path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ ${path}`,
      `@@ -0,0 +1,${Math.max(newLines.length, 1)} @@`,
      body
    ].join("\n");
  }

  const body = [
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`)
  ].join("\n");
  return [
    `diff --git ${path} ${path}`,
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -1,${Math.max(oldLines.length, 1)} +1,${Math.max(newLines.length, 1)} @@`,
    body
  ].join("\n");
}

function toolContentToV2(item: Record<string, unknown>): Record<string, unknown> {
  if (item.type !== "diff") {
    return item;
  }

  const path = typeof item.path === "string" ? item.path : "";
  const oldText = (item.oldText as string | null | undefined) ?? null;
  const newText = typeof item.newText === "string" ? item.newText : "";
  const operation = oldText == null || oldText === "" ? "add" : "modify";

  return {
    type: "diff",
    changes: [
      {
        operation,
        path,
        fileType: "text"
      }
    ],
    patch: path
      ? {
          format: "git_patch",
          text: gitPatchForFile(path, oldText, newText)
        }
      : null
  };
}

function mapToolStatusForV2(status: unknown): unknown {
  return status;
}

function mapToolStatusForV1(status: unknown): unknown {
  // v1 has no `cancelled` tool-call status.
  return status === "cancelled" ? "failed" : status;
}

/** Identity cast for the v1 wire format (builders already emit v1 shapes). */
export function sessionUpdateToV1(update: V1SessionUpdate): V1SessionUpdate {
  const raw = update as unknown as Record<string, unknown>;
  if (raw.sessionUpdate === "tool_call" || raw.sessionUpdate === "tool_call_update") {
    return {
      ...raw,
      status: mapToolStatusForV1(raw.status)
    } as V1SessionUpdate;
  }
  return update;
}

/** Map a builder-emitted (v1-shaped) update onto draft ACP v2. */
export function sessionUpdateToV2(update: V1SessionUpdate): V2SessionUpdate {
  const raw = { ...(update as unknown as Record<string, unknown>) };

  if (raw.sessionUpdate === "tool_call") {
    raw.sessionUpdate = "tool_call_update";
    raw.status = mapToolStatusForV2(raw.status);
    if (Array.isArray(raw.content)) {
      raw.content = raw.content.map((item) =>
        item && typeof item === "object"
          ? toolContentToV2(item as Record<string, unknown>)
          : item
      );
    }
    return raw as V2SessionUpdate;
  }

  if (
    raw.sessionUpdate === "agent_message_chunk" ||
    raw.sessionUpdate === "user_message_chunk" ||
    raw.sessionUpdate === "agent_thought_chunk"
  ) {
    if (typeof raw.messageId !== "string" || raw.messageId.length === 0) {
      raw.messageId = "msg_unknown";
    }
    return raw as V2SessionUpdate;
  }

  if (raw.sessionUpdate === "tool_call_update" && Array.isArray(raw.content)) {
    raw.content = raw.content.map((item) =>
      item && typeof item === "object"
        ? toolContentToV2(item as Record<string, unknown>)
        : item
    );
    return raw as V2SessionUpdate;
  }

  return raw as V2SessionUpdate;
}

export function mapUpdatesToV1(updates: readonly V1SessionUpdate[]): V1SessionUpdate[] {
  return updates.map(sessionUpdateToV1);
}

export function mapUpdatesToV2(updates: readonly V1SessionUpdate[]): V2SessionUpdate[] {
  return updates.map(sessionUpdateToV2);
}
