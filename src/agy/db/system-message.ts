// System message filtering: agy appends internal `<SYSTEM_MESSAGE>` task completion
// notifications into step type 15 (agentText). When translated, these should be
// suppressed so background notifications and command outputs do not render as regular
// assistant response text in ACP clients.

/**
 * True if the text matches an internal agy system message envelope
 * (starts with `<SYSTEM_MESSAGE>\n[Message]`).
 */
export function isSystemMessage(text: string): boolean {
  return /^\s*<SYSTEM_MESSAGE>\s*\n\[Message\]\s+/i.test(text);
}
