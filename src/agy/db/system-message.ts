// System message filtering: agy appends internal `<SYSTEM_MESSAGE>` task completion
// notifications into step type 15 (agentText). When translated, these should be
// suppressed so background notifications and command outputs do not render as regular
// assistant response text in ACP clients.

/** True if the text contains an internal `<SYSTEM_MESSAGE>` payload. */
export function isSystemMessage(text: string): boolean {
  return text.includes("<SYSTEM_MESSAGE>");
}
