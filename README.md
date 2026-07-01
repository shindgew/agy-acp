# agy-acp

ACP adapter for Google Antigravity's `agy` CLI.

The implementation is a TypeScript, `npx`-runnable ACP server built on
`@agentclientprotocol/sdk` that wraps the public `agy --print` command. This
keeps the adapter aligned with the logged-in Antigravity CLI experience and
avoids a separate runtime startup path.

## Architecture

```text
Zed / ACP client
  -> agy-acp SDK NDJSON server over stdio
  -> AgyCliSession (spawns agy, tracks --conversation id)
  -> agy --print --conversation <id> --sandbox ...
       \-> writes to ~/.gemini/antigravity-cli/conversations/<id>.db
  -> StreamPoller polls that SQLite database while agy runs
  -> Translator decodes steps -> ACP session/update notifications
```

The ACP SDK layer owns protocol parsing, validation, JSON-RPC framing, and
client notifications. `AgyAcpAgent` owns sessions, prompt conversion,
cancellation, and persistence. `AgyCliSession` owns `agy` process execution and
conversation-id tracking. Everything under `src/agy-db/` owns turning agy's
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
  steps into ACP updates (`agent_message_chunk`, `tool_call`,
  `session_info_update`, ...) via `src/agy-db/translator.ts` and
  `src/agy-db/updates.ts`,
- `session/load` replays a conversation's full history from its database (with
  an incremental cache keyed on file `(mtime, size)` — see
  `src/agy-db/replay.ts`); `session/resume` restores the same session binding
  without replaying,
- session bindings (which agy conversation a session is bound to, last model
  choice, etc.) persist to `~/.agy-acp-state/sessions.json` so `session/load`
  and `session/resume` survive a server restart — see `src/session-store.ts`,
- separate ACP session `Model` and `Reasoning Effect` pickers populated from
  `agy models` when available,
- an ACP session `Fast Mode` selector that prepends `/fast` to print-mode
  prompts without editing global Antigravity settings,
- cancellation sends `SIGINT` (giving `agy` a chance to flush its database
  before exiting), then `SIGKILL` if the process does not exit,
- `--sandbox` is enabled by default,
- `--dangerously-skip-permissions` is opt-in only.

The conversation-database wire format (`src/agy-db/step-payload.ts`,
`src/agy-db/columns.ts`) was cross-referenced against the reverse-engineering
done by the [shubzkothekar/antigravity-acp](https://github.com/shubzkothekar/antigravity-acp)
project (MIT); the decoding code itself is our own, built on a shared generic
wire-walker rather than a generated client.

## Run

`agy-acp` installs the Antigravity CLI automatically during `initialize` when
`agy` is not already on `PATH`.
The adapter downloads the latest release asset from
[google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli/releases/latest)
into `~/.local/bin/agy`.

You can still install `agy` yourself if you prefer:

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Local development:

```sh
npm run build
node dist/cli.js
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
  is missing, `agy-acp` installs it to `~/.local/bin` and prepends that
  directory to `PATH` for the adapter process.
- `AGY_ACP_CONVERSATIONS_DIR`: where `agy` writes its per-conversation SQLite
  databases, default `~/.gemini/antigravity-cli/conversations`. Override this
  if `agy` uses a different path on your OS.
- `AGY_ACP_STATE_DIR`: where `agy-acp` persists session bindings (for
  `session/load`/`session/resume`), default `~/.agy-acp-state`.

## Model Picker

When the ACP client supports session configuration options, `agy-acp` returns
three options during `session/new`:

- `Model`: a select option with ACP category `model`.
- `Reasoning Effect`: a select option with ACP category `thought_level`.
- `Fast Mode`: an `Off`/`On` select option with ACP category `model_config`.

The adapter discovers model choices by running:

```sh
agy models
```

Selecting a model and reasoning effect sends `session/set_config_option`; later
prompts include:

```sh
agy --print "..." --model "<base model> (<reasoning effect>)"
```

The first discovered model is selected by default for new sessions.
Models ending in `(Low)`, `(Medium)`, or `(High)` are split into a base
model picker plus a reasoning-effect picker. `(Thinking)` is treated as part of
the model name, not as a reasoning-effect suffix.

ACP config values use lowercase slugs (`gemini-3.5-flash`, `medium`, and so
on) while the picker labels stay human-readable (`Gemini 3.5 Flash`, `Medium`,
and so on). The adapter resolves the slug values back to agy's native
`--model` display names when spawning prompts.

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
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | node dist/cli.js
```
