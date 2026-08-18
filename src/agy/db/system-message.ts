// System message filtering: agy appends internal `<SYSTEM_MESSAGE>` task completion
// notifications into step type 15 (agentText). When translated, these should be
// suppressed so background notifications and command outputs do not render as regular
// assistant response text in ACP clients.

/**
 * True if the text matches an internal agy system message envelope
 * (e.g. `<SYSTEM_MESSAGE>\n[Message]...` or `[Message] timestamp=... sender=...`).
 */
export function isSystemMessage(text: string): boolean {
  return /^\s*(?:<SYSTEM_MESSAGE>(?:\s*\n|\s*\r\n|\s)*(?:\[Message\]|\[Notice\]|\[System\]|sender=|content=|timestamp=|priority=|task|Task|\s*$)|\[Message\]\s+timestamp=\S+\s+sender=)/i.test(text);
}

/**
 * True while a growing text value could still become an internal system
 * message envelope. Streaming callers defer these prefixes until they can be
 * classified, avoiding emission of a partial internal marker.
 */
export function isSystemMessagePrefix(text: string): boolean {
  const tag = "<SYSTEM_MESSAGE>";
  const trimmed = text.trimStart();
  const tagCandidate = trimmed.slice(0, Math.min(trimmed.length, tag.length));
  if (tagCandidate.toLowerCase() !== tag.slice(0, tagCandidate.length).toLowerCase()) return false;
  if (trimmed.length <= tag.length) return true;

  const afterTag = trimmed.slice(tag.length);
  const markerStart = afterTag.search(/\S/);
  if (markerStart === -1) return true;

  const markerCandidate = afterTag.slice(markerStart);
  const envelopePrefixes = [
    "[message]",
    "[notice]",
    "[system]",
    "sender=",
    "content=",
    "timestamp=",
    "priority=",
    "task"
  ];
  const lower = markerCandidate.toLowerCase();
  return envelopePrefixes.some((p) => p.startsWith(lower) || lower.startsWith(p));
}
