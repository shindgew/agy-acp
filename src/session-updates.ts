// Protocol-boundary conversion for session/update payloads.
//
// The db layer emits v1-shaped updates (with required messageIds on message
// chunks). v1 clients receive them as-is; v2 clients get the draft-v2 mapping
// (tool_call → tool_call_update, structured diffs, cancelled status, agent-owned
// terminals for execute tools, etc.).

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

/** Stable agent-owned terminal id for an execute tool call. */
export function terminalIdForToolCall(toolCallId: string): string {
  return `agy-term-${toolCallId}`;
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

function isToolCallUpdate(raw: Record<string, unknown>): boolean {
  return raw.sessionUpdate === "tool_call" || raw.sessionUpdate === "tool_call_update";
}

function isExecuteToolUpdate(raw: Record<string, unknown>): boolean {
  return isToolCallUpdate(raw) && raw.kind === "execute";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Strip markdown fences from tool content text blocks (execute builders wrap code). */
function unfence(text: string): string {
  const trimmed = text.replace(/^\s+|\s+$/g, "");
  const match = /^`{3,}[^\n]*\n([\s\S]*?)\n`{3,}$/.exec(trimmed);
  return match ? match[1] : text;
}

function contentTexts(raw: Record<string, unknown>): string[] {
  if (!Array.isArray(raw.content)) return [];
  const texts: string[] = [];
  for (const item of raw.content) {
    const block = asRecord(item);
    if (!block || block.type !== "content") continue;
    const content = asRecord(block.content);
    if (content && typeof content.text === "string" && content.text.length > 0) {
      texts.push(unfence(content.text));
    }
  }
  return texts;
}

export interface ExecuteTerminalMeta {
  terminalId: string;
  toolCallId: string;
  command?: string;
  cwd?: string;
  output?: string;
  exitCode?: number;
  status?: string;
}

/** Extract execute-tool terminal fields from a v1-shaped tool call update. */
export function executeTerminalMeta(update: V1SessionUpdate): ExecuteTerminalMeta | null {
  const raw = update as unknown as Record<string, unknown>;
  if (!isExecuteToolUpdate(raw)) return null;
  const toolCallId = typeof raw.toolCallId === "string" && raw.toolCallId.trim()
    ? raw.toolCallId.trim()
    : "";
  if (!toolCallId) return null;

  const rawInput = asRecord(raw.rawInput) ?? {};
  const rawOutput = asRecord(raw.rawOutput) ?? {};
  const texts = contentTexts(raw);

  const command =
    pickString(rawInput, "CommandLine", "commandLine", "command") ??
    (texts[0]?.includes("\n") ? texts[0].split("\n")[0] : texts[0]) ??
    (typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : undefined);

  const cwd = pickString(rawInput, "Cwd", "cwd");

  let output = typeof rawOutput.output === "string" ? rawOutput.output : undefined;
  if (output == null && texts.length >= 2) {
    // executeUpdate: content[0] = command, content[1] = output when both present.
    output = texts[1];
  } else if (output == null && texts.length === 1 && command && texts[0] !== command) {
    output = texts[0];
  }

  const exitCode = typeof rawOutput.exitCode === "number" ? rawOutput.exitCode : undefined;
  const status = typeof raw.status === "string" ? raw.status : undefined;

  return {
    terminalId: terminalIdForToolCall(toolCallId),
    toolCallId,
    command,
    cwd,
    output,
    exitCode,
    status
  };
}

function utf8ToBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * Build a draft-v2 `terminal_update` for an execute tool call from DB-backed
 * command metadata. Output is a full replacement snapshot (not live PTY bytes);
 * mid-command streaming only appears if agy persists partial field-28 results.
 */
export function terminalUpdateForExecute(meta: ExecuteTerminalMeta): V2SessionUpdate {
  const update: Record<string, unknown> = {
    sessionUpdate: "terminal_update",
    terminalId: meta.terminalId
  };
  if (meta.command) update.command = meta.command;
  if (meta.cwd) update.cwd = meta.cwd;
  if (meta.output != null && meta.output.length > 0) {
    update.output = { data: utf8ToBase64(meta.output) };
  }

  const finished =
    meta.status === "completed" ||
    meta.status === "failed" ||
    meta.status === "cancelled";
  if (finished) {
    const exitStatus: Record<string, unknown> = {};
    if (typeof meta.exitCode === "number") exitStatus.exitCode = meta.exitCode;
    if (meta.status === "cancelled" && meta.exitCode == null) exitStatus.signal = "SIGINT";
    update.exitStatus = exitStatus;
  } else if (typeof meta.exitCode === "number") {
    // Exit code without a terminal status still marks the process as exited.
    update.exitStatus = { exitCode: meta.exitCode };
  }

  return update as V2SessionUpdate;
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

  return raw as V2SessionUpdate;
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

export function mapUpdatesToV1(updates: readonly V1SessionUpdate[]): V1SessionUpdate[] {
  return updates.map(sessionUpdateToV1);
}

export function mapUpdatesToV2(updates: readonly V1SessionUpdate[]): V2SessionUpdate[] {
  return updates.flatMap(expandSessionUpdateToV2);
}
