## Hard Invariants

- **Zero Prompt Injection (MUST NOT)**: `agy-acp` must never inject, synthesize, or forward to `agy` any prompt text that does not originate from the ACP client's `session/prompt` content. It MUST NOT invent conversational framing, follow-ups (e.g. "continue"), wake-up prompts, instructions, or labels — even when keeping a turn open for background work. Every substring sent to agy is either client `ContentBlock` content or agy's native attachment transport (`@path`) for client-provided image bytes. PTY writes during a turn are permission/selection keys or the identical user prompt, never adapter prose.

## References

- **ACP Documentation**: Refer to [agentclientprotocol.com](https://agentclientprotocol.com) for official Agent Client Protocol specifications.
- **Antigravity CLI (`agy`) Changelog**: Refer to the official [google-antigravity/antigravity-cli CHANGELOG.md](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md) for upstream `agy` release notes and CLI updates.

## Debugging

- **DB**: Use `sqlite3` on `~/.gemini/antigravity-cli/conversations/*.db`  + [`Translator`](src/agy/db/translator.ts) replay path to inspect the exact update shapes emitted.
- **Zed Log**: `~/Library/Logs/Zed/Zed.log` and `Zed.log.old` only contain agent process stderr and terminal execution errors, not ACP protocol traffic.