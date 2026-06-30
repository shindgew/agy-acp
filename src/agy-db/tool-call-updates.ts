// Renders decoded agy tool-run steps (`StepPayload.toolRun` plus its typed
// result variants) into ACP `tool_call` updates. Shared helpers first, then one
// builder per tool family, grouped by the ACP `ToolKind` they map to.

import path from "node:path";
import type { SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";
import type { ErrorDetails, PermissionInfo, TaskDetails } from "./columns.js";
import type { SearchHit } from "./step-payload.js";
import type { StepRow } from "./types.js";

// --- shared helpers ----------------------------------------------------------

/** Parse the JSON-encoded tool arguments (`toolRun.call.rawInputJson`), tolerating
 *  missing or malformed payloads. Every builder below needs these args. */
export function parseRawInput(stepRow: StepRow): unknown {
  const rawJson = stepRow.stepPayload.toolRun?.call?.rawInputJson;
  if (typeof rawJson === "string" && rawJson.trim().length > 0) {
    try {
      return JSON.parse(rawJson);
    } catch {
      return null;
    }
  }
  return null;
}

/** Stable tool-call id: agy's own call id when present, else a synthetic id
 *  derived from the step's position and type. */
export function toolCallId(stepRow: StepRow): string {
  return stepRow.stepPayload.toolRun?.call?.callId ?? `agy-${stepRow.idx}-${stepRow.stepType}`;
}

/** Map agy's step `status` column to an ACP tool_call status.
 *  2 = in progress, 3 = completed, 6 = cancelled/aborted, 7 = failed. */
function toolCallStatus(stepRow: StepRow): "in_progress" | "completed" | "failed" {
  switch (stepRow.status) {
    case 2:
      return "in_progress";
    case 6:
    case 7:
      return "failed";
    default:
      return "completed";
  }
}

function textBlock(text: string): Record<string, unknown> {
  return { type: "content", content: { type: "text", text } };
}

function fencedCodeBlock(text: string): string {
  const longestBacktickRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}\n${text}\n${fence}`;
}

function codeBlock(text: string): Record<string, unknown> {
  return textBlock(fencedCodeBlock(text));
}

function errorBlock(e: ErrorDetails): Record<string, unknown> {
  const message = e.message.trim() || e.detail.trim() || "Tool call failed";
  const detail = e.detail.trim() && e.detail.trim() !== message ? `\n${e.detail.trim()}` : "";
  return codeBlock(`Error: ${message}${detail}`);
}

function permissionBlock(p: PermissionInfo): Record<string, unknown> {
  const target = p.value.trim() ? ` (${p.value.trim()})` : "";
  return textBlock(`Permission requested: ${p.kind || "unknown"}${target}`);
}

function taskBlock(t: TaskDetails): Record<string, unknown> {
  const lines = [t.description, t.taskId && `Task: ${t.taskId}`, t.logUri && `Log: ${t.logUri}`].filter(
    (line): line is string => Boolean(line)
  );
  return textBlock(lines.join("\n"));
}

/**
 * Build a `tool_call` update with the envelope common to every tool step: the
 * parsed args become `rawInput`, a decoded error becomes `rawOutput` plus a
 * content block, and `permissions`/`task_details` (when present) are appended
 * as content. Every builder below routes through here.
 */
export function toolCallUpdate(opts: {
  stepRow: StepRow;
  title: string;
  kind: ToolKind;
  status?: "pending" | "in_progress" | "completed" | "failed";
  content?: Record<string, unknown>[];
  locations?: Record<string, unknown>[];
}): SessionUpdate {
  const { stepRow, title, kind, status = toolCallStatus(stepRow), content, locations } = opts;

  const blocks: Record<string, unknown>[] = [...(content ?? [])];
  if (stepRow.task) blocks.push(taskBlock(stepRow.task));
  if (stepRow.permission) blocks.push(permissionBlock(stepRow.permission));
  if (stepRow.error) blocks.push(errorBlock(stepRow.error));

  const rawInput = parseRawInput(stepRow);
  const rawOutput = stepRow.error
    ? { message: stepRow.error.message || stepRow.error.detail, detail: stepRow.error.detail, stackTrace: stepRow.error.stackTrace }
    : undefined;

  return {
    sessionUpdate: "tool_call",
    toolCallId: toolCallId(stepRow),
    title,
    kind,
    status,
    ...(blocks.length > 0 ? { content: blocks } : {}),
    ...(locations && locations.length > 0 ? { locations } : {}),
    ...(rawInput != null ? { rawInput } : {}),
    ...(rawOutput != null ? { rawOutput } : {})
  } as SessionUpdate;
}

/** Absolute path -> project-relative path for display; unchanged if outside cwd. */
function toDisplayPath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile === resolvedCwd || resolvedFile.startsWith(resolvedCwd + path.sep)) {
    return path.relative(resolvedCwd, resolvedFile);
  }
  return filePath;
}

/** Best-effort ACP tool kind for tools without a dedicated builder. */
function toolKind(name: string): ToolKind {
  const n = name.toLowerCase();
  if (/write|edit|patch|replace/.test(n)) return "edit";
  if (/delete|remove/.test(n)) return "delete";
  if (/move|rename/.test(n)) return "move";
  if (/read|view|list/.test(n)) return "read";
  if (/grep|search|find/.test(n)) return "search";
  if (/command|execute|terminal/.test(n)) return "execute";
  if (/think|thought|reason|plan/.test(n)) return "think";
  if (/url|fetch/.test(n)) return "fetch";
  return "other";
}

function pick(o: unknown, ...keys: string[]): unknown {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return undefined;
  for (const key of keys) {
    if (key in o) return (o as Record<string, unknown>)[key];
  }
  return undefined;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Strip a `file://` scheme so the value can be resolved/displayed as a path. */
function fsPath(p: string | null | undefined): string | null {
  if (!p) return null;
  if (!p.startsWith("file://")) return p;
  try {
    return decodeURIComponent(new URL(p).pathname);
  } catch {
    return p.slice("file://".length);
  }
}

// --- per-tool builders --------------------------------------------------------
// agy's rawInputJson keys are inconsistently PascalCase/camelCase across tool
// versions (`TargetFile` vs `targetFile`), so every lookup below tries both.

/** Step types 8/9/17(view_file|list_dir): a file read or directory listing. */
export function readUpdate(stepRow: StepRow, cwd?: string): SessionUpdate {
  const { stepPayload, stepType } = stepRow;
  const toolRun = stepPayload.toolRun;
  const rawInput = parseRawInput(stepRow);
  const displayCwd = fsPath(cwd) ?? undefined;
  const name = toolRun?.call?.namePrimary ?? "";
  const view = stepPayload.viewFile;
  const list = stepPayload.listDirectory;

  let title = "Read";
  const content: Record<string, unknown>[] = [];
  const locations: Record<string, unknown>[] = [];

  if (list || name === "list_dir" || stepType === 9) {
    const dir = fsPath(asStr(list?.dirUri)) ?? fsPath(asStr(pick(rawInput, "DirectoryPath", "directoryPath")));
    const shown = dir ? toDisplayPath(dir, displayCwd) : "";
    title = shown ? `Read ${shown}` : "Read directory";
    if (dir) locations.push({ path: dir });

    const entries = (list?.entries ?? []).filter((e) => e.name.trim().length > 0);
    if (entries.length > 0) {
      content.push(codeBlock(entries.map((e) => `${e.name}${e.isDirectory !== 0 ? "/" : ""}`).join("\n")));
    }
  } else {
    const filePath =
      fsPath(asStr(pick(rawInput, "AbsolutePath", "absolutePath", "FilePath"))) ?? fsPath(asStr(view?.fileUri));
    const shown = filePath ? toDisplayPath(filePath, displayCwd) : "";
    const startLine = asNum(pick(rawInput, "StartLine", "startLine")) ?? asNum(view?.startLine) ?? 1;
    const endLine = asNum(pick(rawInput, "EndLine", "endLine")) ?? asNum(view?.endLine);

    title = shown ? `Read ${shown}` : "Read file";
    if (shown && endLine !== null) title += `:${startLine === 0 ? 1 : startLine}-${endLine}`;
    if (filePath) locations.push({ path: filePath, line: startLine });

    const body = asStr(view?.content);
    if (body) content.push(codeBlock(body));
  }

  return toolCallUpdate({ stepRow, title, kind: "read", content, locations });
}

/** Render grep hits (generic field1..field5) into readable, pipe-joined lines. */
function renderHits(hits: SearchHit[] | undefined): string {
  if (!hits || hits.length === 0) return "";
  return hits
    .map((h) => [h.field1, h.field2, h.field3, h.field4, h.field5].filter((v) => v.trim().length > 0).join(" | "))
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Step types 7/33(grep_search|search_web): a filesystem or web search. */
export function searchUpdate(stepRow: StepRow, cwd?: string): SessionUpdate {
  const { stepPayload, stepType } = stepRow;
  const name = stepPayload.toolRun?.call?.namePrimary ?? "";
  const rawInput = parseRawInput(stepRow);
  const displayCwd = fsPath(cwd) ?? undefined;
  const grep = stepPayload.grepSearch;

  let title = "Search";
  const content: Record<string, unknown>[] = [];
  const locations: Record<string, unknown>[] = [];

  if (grep || name === "grep_search" || stepType === 7) {
    const query = asStr(grep?.query) ?? asStr(pick(rawInput, "Query", "query")) ?? "";
    const searchPath = fsPath(asStr(pick(rawInput, "SearchPath", "searchPath"))) ?? fsPath(asStr(grep?.cwdUri));
    const shown = searchPath ? toDisplayPath(searchPath, displayCwd) : "";
    title = shown ? `Search '${query}' ${shown}` : `Search '${query}'`;
    if (searchPath) locations.push({ path: searchPath });

    const body = asStr(grep?.textOutput)?.trim() || renderHits(grep?.hits) || asStr(grep?.shellCommand)?.trim();
    if (body) content.push(codeBlock(body));
  } else {
    // search_web is call-only (no result body decoded into the payload).
    const query = asStr(pick(rawInput, "query", "Query"))?.trim() ?? "";
    title = query ? `Web search ${query}` : "Web search";
  }

  return toolCallUpdate({ stepRow, title, kind: "search", content, locations });
}

/** Step type 21 (run_command): a shell command execution. */
export function executeUpdate(stepRow: StepRow): SessionUpdate {
  const toolRun = stepRow.stepPayload.toolRun;
  const rawInput = parseRawInput(stepRow);
  const command = asStr(pick(rawInput, "CommandLine", "commandLine", "command"));
  const firstLine = (command?.split("\n")[0] ?? "").trim();

  const title =
    firstLine || asStr(toolRun?.titlePrimary)?.trim() || asStr(toolRun?.titleSecondary)?.trim() || "Command Execution";

  const content: Record<string, unknown>[] = command?.trim() ? [codeBlock(command)] : [];

  // The only path a run_command exposes is its working directory.
  const commandCwd = fsPath(asStr(pick(rawInput, "Cwd", "cwd")));
  const locations = commandCwd ? [{ path: commandCwd }] : [];

  return toolCallUpdate({ stepRow, title, kind: "execute", content, locations });
}

/** Step type 31 (read_url_content): a call-only step; the fetched body isn't decoded. */
export function fetchUpdate(stepRow: StepRow): SessionUpdate {
  const toolRun = stepRow.stepPayload.toolRun;
  const rawInput = parseRawInput(stepRow);
  const url = asStr(pick(rawInput, "Url", "url"))?.trim();

  const title =
    (url ? `Fetch ${url}` : null) ||
    asStr(toolRun?.titlePrimary)?.trim() ||
    asStr(toolRun?.titleSecondary)?.trim() ||
    "Fetch URL";

  return toolCallUpdate({ stepRow, title, kind: "fetch", content: url ? [textBlock(url)] : [] });
}

function isPlanFile(targetFile: string): boolean {
  return (
    targetFile.includes(".gemini") &&
    targetFile.includes("antigravity-cli") &&
    targetFile.includes("brain") &&
    targetFile.endsWith("md")
  );
}

/** Step type 5 (write_to_file|replace_file_content|multi_replace_file_content),
 *  and step 17 artifact writes (e.g. a generated `plan.md` for user review). */
export function editUpdate(stepRow: StepRow, cwd?: string): SessionUpdate | SessionUpdate[] {
  const rawInput = parseRawInput(stepRow);
  const displayCwd = fsPath(cwd) ?? undefined;

  const targetFile = fsPath(asStr(pick(rawInput, "TargetFile", "targetFile"))) ?? "";
  const isPlan = isPlanFile(targetFile);
  const shown = targetFile ? toDisplayPath(targetFile, displayCwd) : "";
  const title = isPlan ? (shown.split("/").pop() ?? "Implementation Plan") : shown ? `Edit ${shown}` : "Edit";

  const content: Record<string, unknown>[] = [];
  const locations: Record<string, unknown>[] = [];

  const fullContent = asStr(pick(rawInput, "CodeContent", "codeContent"));
  if (fullContent !== null) {
    // write_to_file: the whole file content is the new text.
    if (isPlan) {
      content.push(textBlock(fullContent)); // plans are user-facing prose, not a code diff
    } else if (targetFile) {
      content.push({ type: "diff", path: targetFile, oldText: null, newText: fullContent });
    }
    if (targetFile) locations.push({ path: targetFile });
  } else if (!isPlan) {
    // replace_file_content (one inline chunk) or multi_replace_file_content
    // (a ReplacementChunks array) — normalize both to a list of chunks.
    const chunksRaw = pick(rawInput, "ReplacementChunks", "replacementChunks");
    const chunks = Array.isArray(chunksRaw) ? chunksRaw : [rawInput];

    for (const chunk of chunks) {
      const newText = asStr(pick(chunk, "ReplacementContent", "replacementContent"));
      if (newText === null || !targetFile) continue;
      const oldText = asStr(pick(chunk, "TargetContent", "targetContent"));
      content.push({ type: "diff", path: targetFile, oldText, newText });

      const line = asNum(pick(chunk, "StartLine", "startLine"));
      locations.push(line !== null ? { path: targetFile, line } : { path: targetFile });
    }
  }

  if (isPlan && content.length === 0) return [];
  return toolCallUpdate({ stepRow, title, kind: "edit", content, locations });
}

/** Step type 138 (ask_question): the agent poses one or more multiple-choice questions. */
export function questionUpdate(stepRow: StepRow): SessionUpdate {
  const toolRun = stepRow.stepPayload.toolRun;
  const rawInput = parseRawInput(stepRow);
  const questionsRaw = pick(rawInput, "questions", "Questions");
  const questions = Array.isArray(questionsRaw) ? questionsRaw : [];

  const firstQuestion = asStr(pick(questions[0], "question", "Question"))?.trim();
  const title =
    firstQuestion || asStr(toolRun?.titlePrimary)?.trim() || asStr(toolRun?.titleSecondary)?.trim() || "Ask question";

  const content: Record<string, unknown>[] = [];
  for (const q of questions) {
    const question = asStr(pick(q, "question", "Question"))?.trim();
    if (!question) continue;
    const optionsRaw = pick(q, "options", "Options");
    const options = Array.isArray(optionsRaw) ? optionsRaw : [];
    const lines = [question, ...options.map((opt) => asStr(opt) ?? asStr(pick(opt, "label", "Label"))).filter((label): label is string => Boolean(label)).map((label) => `  - ${label}`)];
    content.push(textBlock(lines.join("\n")));
  }

  return toolCallUpdate({ stepRow, title, kind: "other", content });
}

/** Step type 127 (invoke_subagent): delegates one or more tasks to subagents. */
export function subagentUpdate(stepRow: StepRow): SessionUpdate {
  const toolRun = stepRow.stepPayload.toolRun;
  const rawInput = parseRawInput(stepRow);
  const subagentsRaw = pick(rawInput, "Subagents", "subagents");
  const subagents = Array.isArray(subagentsRaw) ? subagentsRaw : [];

  const title =
    subagents.length > 0
      ? `Delegate to ${subagents.length} subagent${subagents.length > 1 ? "s" : ""}`
      : asStr(toolRun?.titleSecondary)?.trim() || asStr(toolRun?.titlePrimary)?.trim() || "Invoke subagent";

  const content = subagents
    .map((s) => asStr(pick(s, "Prompt", "prompt"))?.trim())
    .filter((prompt): prompt is string => Boolean(prompt))
    .map(codeBlock);

  return toolCallUpdate({ stepRow, title, kind: "other", content });
}

/**
 * Step type 132 orchestration tools (manage_task/schedule/send_message/
 * manage_subagents), plus the generic fallback for any tool without a
 * dedicated builder above.
 */
export function otherUpdate(stepRow: StepRow): SessionUpdate {
  const toolRun = stepRow.stepPayload.toolRun;
  const name = toolRun?.call?.namePrimary ?? "";
  const rawInput = parseRawInput(stepRow);

  switch (name) {
    case "manage_task": {
      const action = asStr(pick(rawInput, "Action", "action"))?.trim() || "manage";
      const taskId = asStr(pick(rawInput, "TaskId", "taskId"));
      return toolCallUpdate({
        stepRow,
        title: `Manage task ${action}`,
        kind: "other",
        content: taskId ? [textBlock(`Task: ${taskId}`)] : []
      });
    }
    case "schedule": {
      const duration = asStr(pick(rawInput, "DurationSeconds", "durationSeconds"));
      const prompt = asStr(pick(rawInput, "Prompt", "prompt"))?.trim();
      return toolCallUpdate({
        stepRow,
        title: duration ? `Schedule timer (${duration}s)` : "Schedule timer",
        kind: "other",
        content: prompt ? [textBlock(prompt)] : []
      });
    }
    case "send_message": {
      const message = asStr(pick(rawInput, "Message", "message"))?.trim();
      return toolCallUpdate({
        stepRow,
        title: "Send message to subagent",
        kind: "other",
        content: message ? [textBlock(message)] : []
      });
    }
    case "manage_subagents": {
      const action = asStr(pick(rawInput, "Action", "action"))?.trim() || "manage";
      return toolCallUpdate({ stepRow, title: `Subagents: ${action}`, kind: "other" });
    }
  }

  // Generic fallback: prefer the human-readable summary, then the generic tool
  // titles, then the raw tool name (toolAction is often misleading, so last resort).
  const title =
    asStr(toolRun?.titlePrimary)?.trim() ||
    asStr(pick(rawInput, "toolSummary", "ToolSummary"))?.trim() ||
    asStr(toolRun?.titleSecondary)?.trim() ||
    name ||
    "Tool";

  const content: Record<string, unknown>[] = [];
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const { toolAction: _toolAction, toolSummary: _toolSummary, ...rest } = rawInput as Record<string, unknown>;
    if (Object.keys(rest).length > 0) content.push(codeBlock(JSON.stringify(rest, null, 2)));
  }

  return toolCallUpdate({ stepRow, title, kind: toolKind(name), content });
}
