// `session/update` payload wire mapping (v1-shaped builders → v1 wire / draft
// v2). Distinct from update.ts, which owns the actual `client.notify(...)`
// call sites for out-of-band updates (mode/config/available-commands) — this
// file only shapes the payload for any given update, including the ones
// streamed from the agy db layer during a prompt turn.
// Docs: https://agentclientprotocol.com/protocol/v1/prompt-turn
//
// The agy db layer emits v1-shaped updates (with required messageIds on message
// chunks). v1 clients receive them as-is; v2 clients get the draft-v2 mapping
// (tool_call → tool_call_update, structured diffs, cancelled status, agent-owned
// terminals for execute tools, etc.).

import type { SessionUpdate as V1SessionUpdate } from "@agentclientprotocol/sdk";
import type { SessionUpdate as V2SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { asRecord, executeTerminalMeta, terminalUpdateForExecute } from "../terminal/index.js";

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

function withTerminalContent(
  content: unknown,
  terminalId: string
): Record<string, unknown>[] {
  const terminalBlock = { type: "terminal", terminalId };
  if (!Array.isArray(content) || content.length === 0) {
    return [terminalBlock];
  }
  const mapped = content.map((item) =>
    item && typeof item === "object"
      ? toolContentToV2(item as Record<string, unknown>)
      : item
  ) as Record<string, unknown>[];
  // Avoid duplicating the same terminal embed on progressive updates.
  if (mapped.some((item) => item?.type === "terminal" && item.terminalId === terminalId)) {
    return mapped;
  }
  return [terminalBlock, ...mapped];
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
  // Drop agent-private plan _meta keys from the v1 wire (entries stay).
  if (raw.sessionUpdate === "plan" && raw._meta && typeof raw._meta === "object") {
    const { _meta: _drop, ...rest } = raw;
    return rest as V1SessionUpdate;
  }
  return update;
}

/**
 * Map a builder-emitted (v1-shaped) update onto a single draft ACP v2 update.
 * Prefer {@link expandSessionUpdateToV2} on the wire — execute tools also emit
 * a sibling `terminal_update`.
 */
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

  // Classic v1 `plan` → draft v2 `plan_update` with structured items.
  // Prefer markdown content when the translator stashed it in _meta.
  if (raw.sessionUpdate === "plan") {
    return planToV2(raw);
  }

  return raw as V2SessionUpdate;
}

function planToV2(raw: Record<string, unknown>): V2SessionUpdate {
  const meta = asRecord(raw._meta);
  const planId =
    (typeof meta?.["agy-acp/planId"] === "string" && meta["agy-acp/planId"]) ||
    (typeof meta?.["agy-acp/planPath"] === "string" && `file:${meta["agy-acp/planPath"]}`) ||
    "agy-plan";
  const markdown =
    typeof meta?.["agy-acp/planMarkdown"] === "string" ? meta["agy-acp/planMarkdown"] : null;
  const entries = Array.isArray(raw.entries) ? raw.entries : [];

  // Prefer markdown when available (full fidelity of the brain artifact);
  // otherwise fall back to item entries from the classic plan shape.
  if (markdown !== null && markdown.length > 0) {
    return {
      sessionUpdate: "plan_update",
      plan: {
        type: "markdown",
        planId,
        content: markdown
      }
    } as V2SessionUpdate;
  }

  return {
    sessionUpdate: "plan_update",
    plan: {
      type: "items",
      planId,
      entries
    }
  } as V2SessionUpdate;
}

/**
 * Expand one v1-shaped update into one or more v2 session updates.
 * Execute tools produce `terminal_update` then `tool_call_update` with a
 * display-only `{ type: "terminal", terminalId }` content block.
 */
export function expandSessionUpdateToV2(update: V1SessionUpdate): V2SessionUpdate[] {
  const meta = executeTerminalMeta(update);
  if (!meta) {
    return [sessionUpdateToV2(update)];
  }

  const tool = sessionUpdateToV2(update) as unknown as Record<string, unknown>;
  tool.content = withTerminalContent(tool.content, meta.terminalId);

  return [terminalUpdateForExecute(meta), tool as V2SessionUpdate];
}

