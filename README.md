# agy-acp

ACP adapter for Google Antigravity's `agy` CLI.

The implementation is a TypeScript, `npx`-runnable ACP server built on
`@agentclientprotocol/sdk` that wraps the public `agy --print` command. This
keeps the adapter aligned with the logged-in Antigravity CLI experience and
avoids a separate runtime startup path.

**Current package:** `1.0.0-alpha.0` (pre-release). Supports **ACP v1** and
**experimental draft ACP v2** side by side via version negotiation on
`initialize`. See the [ACP v2 draft announcement](https://agentclientprotocol.com/announcements/acp-v2-draft)
and [migration guide](https://agentclientprotocol.com/protocol/v2/migration).
Draft v2 may still change before stabilization.

## Architecture

```text
Zed / ACP client
  -> agy-acp dual protocol router (v1 or draft v2 from initialize)
  -> AgyAcpAgent (sessions, config, prompt lifecycle)
  -> AgyCliSession (spawns agy, tracks --conversation id)
  -> agy --print --conversation <id> --sandbox ...
       \-> writes to ~/.gemini/antigravity-cli/conversations/<id>.db
  -> StreamPoller polls that SQLite database while agy runs
  -> Translator decodes steps -> ACP session/update notifications
```

The ACP SDK layer owns protocol parsing, validation, JSON-RPC framing, and
client notifications. `AgyAcpAgent` owns sessions, prompt conversion,
cancellation, and persistence. `AgyCliSession` owns `agy` process execution and
conversation-id tracking. Everything under `src/db/` owns turning agy's
conversation database into ACP updates.

Earlier versions of this adapter read `agy --print`'s stdout and used regex
heuristics to guess which lines were "thinking" narration. `agy` itself
persists every conversation turn-by-turn to an append-only SQLite database as
it runs, with structured (reverse-engineered, since `agy` doesn't publish a
schema) protobuf step records — tool calls, task/permission/error details, and
titles all included. `agy-acp` now reads that database directly instead:

- one `agy --print --conversation <id>` subprocess per ACP prompt (the
  conversation id is learned from the first turn and reused after),
- stdout is drained but never parsed; a `StreamPoller` polls the conversation
  database on an interval while the process runs, translating newly-appended
  steps into ACP updates (`agent_message_chunk`, `tool_call` /
  v2 `tool_call_update`, `session_info_update`, ...) via `src/db/translator.ts`
  and `src/db/updates.ts`,
- **ACP v1:** `session/load` replays history; `session/resume` reattaches without
  replay. **ACP v2:** only `session/resume` — pass `replayFrom: { "type": "start" }`
  to replay (replaces v1 load). Replay uses an incremental cache keyed on file
  `(mtime, size)` — see `src/db/replay.ts`,
- **ACP v2 prompt lifecycle:** `session/prompt` returns `{}` on acceptance;
  foreground progress uses `state_update` (`running` / `idle` with `stopReason`);
  the user message is acknowledged with a required `messageId`,
- session bindings (which agy conversation a session is bound to, last model
  choice, etc.) persist to `~/.agy-acp-state/sessions.json` so list/load/resume
  survive a server restart — see `src/session-store.ts`,
- `session/list` is advertised on both protocol versions,
- separate ACP session `Model` and `Reasoning Effort` pickers populated from
  `agy models` when available (effort maps to `agy --effort`),
- an ACP session `Fast Mode` selector that prepends `/fast` to print-mode
  prompts without editing global Antigravity settings,
- cancellation sends `SIGINT` (giving `agy` a chance to flush its database
  before exiting), then `SIGKILL` if the process does not exit,
- `--sandbox` is enabled by default,
- `--dangerously-skip-permissions` is opt-in only.

The conversation-database wire format (`src/db/step-payload.ts`,
`src/db/columns.ts`) was cross-referenced against the reverse-engineering
done by the [shubzkothekar/antigravity-acp](https://github.com/shubzkothekar/antigravity-acp)
project (MIT); the decoding code itself is our own, built on a shared generic
wire-walker rather than a generated client.

## Run

`agy-acp` installs the Antigravity CLI automatically during `initialize` when
`agy` is not already on `PATH`.
The adapter downloads the latest release asset from
[google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli/releases/latest)
into `~/.local/bin/agy` (checksum-verified when GitHub publishes a digest), and
prepends that directory to `PATH` for the adapter process.

You can still install `agy` yourself if you prefer:

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Local development:

```sh
npm run build
node dist/main.js
```

Published package / Zed:

```sh
npx agy-acp
```

Example Zed custom agent shape:

```json
{
  "agent_servers": {
    "Google Antigravity": {
      "command": "npx",
      "args": ["agy-acp"],
      "env": {
        "PATH": "/path/to/agy/bin" // Optional
      }
    }
  }
}
```

Optional environment variables:

- `PATH`: include the directory that contains `agy` when the agent process does
  not inherit your shell `PATH` (common in editor-launched agents). When `agy`
  is missing, `agy-acp` installs it to `~/.local/bin` from GitHub Releases and
  prepends that directory to `PATH` for the adapter process.
- `AGY_ACP_CONVERSATIONS_DIR`: where `agy` writes its per-conversation SQLite
  databases, default `~/.gemini/antigravity-cli/conversations`. Override this
  if `agy` uses a different path on your OS.
- `AGY_ACP_STATE_DIR`: where `agy-acp` persists session bindings (for
  `session/load`/`session/resume`), default `~/.agy-acp-state`.

## Model Picker

When the ACP client supports session configuration options, `agy-acp` returns
three options during `session/new`:

- `Model`: a select option with ACP category `model`.
- `Reasoning Effort`: a select option with ACP category `thought_level` (config id `effort`).
- `Fast Mode`: an `Off`/`On` select option with ACP category `model_config`.

The adapter discovers model choices by running:

```sh
agy models
```

On current Antigravity CLI releases (`agy` ≥ 1.1.5), that command lists stable
slugs such as `gemini-3.5-flash-medium` and `claude-opus-4-6-thinking`. The
adapter groups those into a base model plus optional effort:

| `agy models` line | Model picker | Effort picker |
|---|---|---|
| `gemini-3.5-flash-medium` | `gemini-3.5-flash` | `medium` |
| `gemini-3.5-flash-high` | `gemini-3.5-flash` | `high` |
| `claude-opus-4-6-thinking` | `claude-opus-4-6-thinking` | N/A |
| `claude-sonnet-4-6` | `claude-sonnet-4-6` | N/A |

Selecting a model and effort sends `session/set_config_option`; later prompts
include:

```sh
agy --print "..." --model gemini-3.5-flash --effort high
```

Models without effort variants only pass `--model`. Thinking models keep
`-thinking` as part of the model identity (not as an `--effort` value).

Legacy display-name lists (`Gemini 3.5 Flash (Medium)`) are still parsed for
compatibility. Picker labels stay human-readable (`Gemini 3.5 Flash`,
`Medium`, …).

Enabling `Fast Mode` sends `/fast` before the user prompt in the transient
`agy --print` session. This mirrors Antigravity CLI Fast Mode without mutating
`~/.gemini/antigravity-cli/settings.json`.

## Session Persistence

`agy-acp` advertises `loadSession: true` and the `resume`/`close`
`sessionCapabilities`:

- `session/load` restores a session's working directory, model/mode
  selection, and agy conversation binding, then replays the conversation's
  full history as ACP updates before returning — useful when an ACP client
  reconnects to a fresh `agy-acp` process (e.g. after an editor restart).
- `session/resume` restores the same binding without replaying history, for
  clients that only need to continue prompting.

Both work by reading the session binding persisted after every prompt/config
change (see `AGY_ACP_STATE_DIR` above) and, for `session/load`, replaying the
bound agy conversation database from `AGY_ACP_CONVERSATIONS_DIR`.

## Development

Run the TypeScript tests:

```sh
npm test
```

Smoke-test the ACP initialize handshake:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | node dist/main.js
```
