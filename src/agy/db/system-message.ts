// System message filtering: agy appends internal `<SYSTEM_MESSAGE>` task completion
// notifications into step type 15 (agentText). When translated, these should be
// suppressed so background notifications and command outputs do not render as regular
// assistant response text in ACP clients.

/**
 * True if the text is an internal `<SYSTEM_MESSAGE>` envelope injected by agy
 * (starts with `<SYSTEM_MESSAGE>` at the beginning of the text payload).
 */
export function isSystemMessage(text: string): boolean {
  return /^\s*<SYSTEM_MESSAGE>/i.test(text);
}
