// ACP Tool Calls: session/request_permission option menus for agy status-9 tools.
// Docs: https://agentclientprotocol.com/protocol/v1/tool-calls

import type { SessionUpdate } from "@agentclientprotocol/sdk";

/**
 * Option ids for permission menus and ask_question.
 * Edit tools use standard ACP ids (`allow-once` / `reject-once` / `allow-always`)
 * so clients can map them to native Keep / Reject UI.
 */
export type PermissionChoice = string;

export interface PermissionMenuOption {
  optionId: PermissionChoice;
  kind: "allow_once" | "allow_always" | "reject_once";
  name: string;
}

export interface AskQuestionPayload {
  question: string;
  options: string[];
  multiSelect: boolean;
  questionCount: number;
}

/**
 * Status-9 tools that can be answered through ACP `session/request_permission`
 * and PTY key injection. `ask_question` is handled separately (MCQ, not a
 * permission panel).
 */
export function isBridgeablePermissionTool(toolName: string): boolean {
  if (!toolName || toolName === "ask_question") return false;
  if (toolName === "run_command") return true;
  if (toolName === "ask_permission") return true;
  if (toolName === "view_file" || toolName === "list_dir") return true;
  if (isEditToolName(toolName)) return true;
  return false;
}

export function isEditToolName(toolName: string): boolean {
  return Boolean(toolName) && /write|replace|edit|patch/.test(toolName);
}

/** True when an ACP tool_call update is a file edit (kind or tool name). */
export function isEditToolCall(toolCall: SessionUpdate): boolean {
  const raw = toolCall as unknown as Record<string, unknown>;
  if (raw.kind === "edit") return true;
  return false;
}

/** True when this status-9 tool can be bridged (permission menu, single-select MCQ, or elicitation). */
export function canBridgeInteraction(
  toolName: string,
  toolCall?: SessionUpdate,
  options?: { hasElicitation?: boolean }
): boolean {
  if (isBridgeablePermissionTool(toolName)) return true;
  if (toolName !== "ask_question" || !toolCall) return false;
  if (options?.hasElicitation) return true;
  const ask = parseAskQuestion(toolCall);
  return ask != null && isBridgeableAskQuestion(ask);
}

/** Single-select, single-question ask_question is safe to map to PTY keys. */
export function isBridgeableAskQuestion(ask: AskQuestionPayload): boolean {
  return ask.questionCount === 1 && !ask.multiSelect && ask.options.length > 0;
}

/** Normalize client-selected option ids (standard ACP or legacy agy-*). */
export function normalizePermissionChoice(choice: string): PermissionChoice {
  switch (choice) {
    case "allow-once":
    case "allow_once":
      return "agy-allow-once";
    case "allow-always":
    case "allow_always":
      return "agy-allow-settings";
    case "allow-conversation":
      return "agy-allow-conversation";
    case "reject-once":
    case "reject_once":
    case "reject":
      return "agy-reject-once";
    default:
      return choice;
  }
}

export function permissionKeys(choice: PermissionChoice): string | null {
  const id = normalizePermissionChoice(choice);
  switch (id) {
    case "agy-allow-once": return "\r";
    case "agy-allow-conversation": return "\x1b[B\r";
    case "agy-allow-settings": return "\x1b[B\x1b[B\r";
    case "agy-reject-once": return "\x1b[B\x1b[B\x1b[B\r";
    default: return null;
  }
}

/**
 * Map an ACP option id to PTY keypresses for the given interaction.
 * Returns null when the choice cannot be applied safely.
 */
export function interactionKeys(
  choice: PermissionChoice,
  toolName: string,
  toolCall?: SessionUpdate
): string | null {
  if (choice.startsWith("pty-keys:")) {
    return choice.slice("pty-keys:".length);
  }

  if (toolName === "ask_question") {
    if (choice === "agy-q-skip") return "\x1b"; // Esc — cancel / skip the modal
    const match = /^agy-q-(\d+)$/.exec(choice);
    if (!match || !toolCall) return null;
    const index = Number(match[1]);
    const ask = parseAskQuestion(toolCall);
    if (!ask || !isBridgeableAskQuestion(ask) || index < 0 || index >= ask.options.length) return null;
    // First option is focused by default; Down N then Enter selects option N.
    return `${"\x1b[B".repeat(index)}\r`;
  }

  // Edit tools: map standard ACP allow/reject onto agy's 4-row menu.
  // Accept/allow-once → first row; always-allow → settings row; reject → last row.
  if (isEditToolName(toolName)) {
    const id = normalizePermissionChoice(choice);
    if (id === "agy-allow-once") return "\r";
    if (id === "agy-allow-settings") return "\x1b[B\x1b[B\r";
    if (id === "agy-allow-conversation") return "\x1b[B\r";
    if (id === "agy-reject-once") return "\x1b[B\x1b[B\x1b[B\r";
    return null;
  }

  return permissionKeys(choice);
}

function pickString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function toolRawInput(toolCall: SessionUpdate): Record<string, unknown> {
  const raw = toolCall as unknown as Record<string, unknown>;
  return raw.rawInput && typeof raw.rawInput === "object" && !Array.isArray(raw.rawInput)
    ? raw.rawInput as Record<string, unknown>
    : {};
}

/** Parse ask_question rawInput into a stable shape for bridging. */
export function parseAskQuestion(toolCall: SessionUpdate): AskQuestionPayload | null {
  const input = toolRawInput(toolCall);
  const questionsRaw = input.questions ?? input.Questions;
  const questions = Array.isArray(questionsRaw) ? questionsRaw : [];
  if (questions.length === 0) return null;

  const first = questions[0];
  const entry = first && typeof first === "object" && !Array.isArray(first)
    ? first as Record<string, unknown>
    : {};
  const question =
    pickString(entry, "question", "Question") ??
    String((toolCall as unknown as { title?: unknown }).title ?? "Question");
  const optionsRaw = entry.options ?? entry.Options;
  const optionsList = Array.isArray(optionsRaw) ? optionsRaw : [];
  const options = optionsList
    .map((opt) => {
      if (typeof opt === "string") return opt.trim();
      if (opt && typeof opt === "object" && !Array.isArray(opt)) {
        return pickString(opt as Record<string, unknown>, "label", "Label", "text", "Text", "id", "Id") ?? "";
      }
      return "";
    })
    .filter(Boolean);
  const multiSelect = Boolean(entry.is_multi_select ?? entry.isMultiSelect ?? entry.IsMultiSelect);

  return {
    question,
    options,
    multiSelect,
    questionCount: questions.length
  };
}

/** Build ACP permission options for the given pending tool interaction. */
export function permissionOptions(toolCall: SessionUpdate, toolName?: string): PermissionMenuOption[] {
  if (toolName === "ask_question") {
    return askQuestionOptions(toolCall);
  }

  // agy's sandbox-bypass request (run a command / read a file outside the
  // sandbox). Its TUI menu is the same 4-row layout as run_command
  // (Yes / always-in-conversation / persist / No), so the standard
  // permissionKeys navigation applies.
  if (toolName === "ask_permission") {
    return askPermissionOptions(toolCall);
  }

  // File edits: standard ACP option ids/kinds so clients can render native
  // Keep / Reject (or equivalent) review UI against the tool_call diff.
  if (isEditToolName(toolName ?? "") || (toolName == null && isEditToolCall(toolCall))) {
    return standardEditPermissionOptions();
  }

  const raw = toolCall as unknown as Record<string, unknown>;
  const input = toolRawInput(toolCall);
  const command = pickString(input, "CommandLine", "commandLine", "command");
  const filePath = pickString(
    input,
    "TargetFile",
    "targetFile",
    "AbsolutePath",
    "absolutePath",
    "FilePath",
    "DirectoryPath",
    "directoryPath"
  );

  const useCommandMenu =
    toolName === "run_command" ||
    ((toolName == null || toolName === "") && Boolean(command) && !filePath);

  if (useCommandMenu) {
    const target = command ?? String(raw.title ?? "this command");
    return [
      { optionId: "agy-allow-once", kind: "allow_once", name: "Yes" },
      {
        optionId: "agy-allow-conversation",
        kind: "allow_always",
        name: `Yes, and always allow in this conversation for commands that start with '${target}'`
      },
      {
        optionId: "agy-allow-settings",
        kind: "allow_always",
        name: `Yes, and always allow for commands that start with '${target}' (Persist to settings.json)`
      },
      { optionId: "agy-reject-once", kind: "reject_once", name: "No" }
    ];
  }

  // Generic tool menus (e.g. read_file) from agy 1.1.5 TUI strings.
  const grant = permissionGrantLabel(toolName, filePath, raw.title);
  return [
    { optionId: "agy-allow-once", kind: "allow_once", name: "Yes" },
    {
      optionId: "agy-allow-conversation",
      kind: "allow_always",
      name: `Yes, and always allow '${grant}' in this conversation`
    },
    {
      optionId: "agy-allow-settings",
      kind: "allow_always",
      name: `Yes, and always allow '${grant}' (Persist to settings.json)`
    },
    { optionId: "agy-reject-once", kind: "reject_once", name: "No" }
  ];
}

/**
 * Standard ACP permission options for file edits.
 * Clients (Zed, Grok Build as ACP host, etc.) key off `kind` for Keep/Reject UI.
 * @see https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission
 */
function standardEditPermissionOptions(): PermissionMenuOption[] {
  return [
    { optionId: "allow-once", kind: "allow_once", name: "Allow" },
    { optionId: "allow-always", kind: "allow_always", name: "Always allow" },
    { optionId: "reject-once", kind: "reject_once", name: "Reject" }
  ];
}

/**
 * Options for agy's `ask_permission` sandbox-bypass request. rawInput carries
 * `Action` (e.g. `run_command` / `read_file`), `Target`, and `Reason`; the TUI
 * renders the standard 4-row permission menu, so we mirror run_command's ids.
 */
function askPermissionOptions(toolCall: SessionUpdate): PermissionMenuOption[] {
  const input = toolRawInput(toolCall);
  const raw = toolCall as unknown as Record<string, unknown>;
  const target =
    pickString(input, "Target", "target", "CommandLine", "commandLine", "command") ??
    pickString(input, "toolAction", "ToolAction") ??
    (typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "this action");
  return [
    { optionId: "agy-allow-once", kind: "allow_once", name: "Yes" },
    {
      optionId: "agy-allow-conversation",
      kind: "allow_always",
      name: `Yes, and always allow '${target}' in this conversation`
    },
    {
      optionId: "agy-allow-settings",
      kind: "allow_always",
      name: `Yes, and always allow '${target}' (Persist to settings.json)`
    },
    { optionId: "agy-reject-once", kind: "reject_once", name: "No" }
  ];
}

function askQuestionOptions(toolCall: SessionUpdate): PermissionMenuOption[] {
  const ask = parseAskQuestion(toolCall);
  if (!ask || !isBridgeableAskQuestion(ask)) {
    return [{ optionId: "agy-q-skip", kind: "reject_once", name: "Skip" }];
  }
  const options: PermissionMenuOption[] = ask.options.map((name, index) => ({
    optionId: `agy-q-${index}`,
    kind: "allow_once" as const,
    name
  }));
  options.push({ optionId: "agy-q-skip", kind: "reject_once", name: "Skip" });
  return options;
}

/** Format the grant pattern shown in agy menus / settings.allow rules. */
function permissionGrantLabel(
  toolName: string | undefined,
  filePath: string | undefined,
  title: unknown
): string {
  const isRead = toolName === "view_file" || toolName === "list_dir";
  const kind = isRead ? "read_file" : "write_file";
  if (filePath) return `${kind}(${filePath})`;
  if (typeof title === "string" && title.trim()) return title.trim();
  return `${kind}(*)`;
}
