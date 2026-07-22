# agy-acp

ACP adapter for Google Antigravity's `agy` CLI.

The implementation is a TypeScript, `npx`-runnable ACP server built on
`@agentclientprotocol/sdk` that wraps the public `agy --print` command. This
keeps the adapter aligned with the logged-in Antigravity CLI experience and
avoids a separate runtime startup path.

**Current package:** `0.2.7` (`latest`). Supports **ACP v1** and
**experimental draft ACP v2** side by side via version negotiation on
`initialize`. Draft ACP v2 work continues on the `alpha` dist-tag
(`1.0.0-alpha.*`). See the [ACP v2 draft announcement](https://agentclientprotocol.com/announcements/acp-v2-draft)
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
  steps into ACP updates (`agent_message_chunk`, `agent_thought_chunk`,
  progressive `tool_call` → `tool_call_update`, `session_info_update`, ...)
  via `src/db/translator.ts` and `src/db/updates.ts`,
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
- ACP session config options in order: `mode`, `model`, `reasoningEffort`
  (mode → `agy --mode`; model → `agy --model`; reasoningEffort → `agy --effort`),
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
npx agy-acp                 # latest stable (0.2.7)
npx agy-acp@alpha           # latest alpha pre-release channel
npx agy-acp@1.0.0-alpha.0   # pin a specific pre-release
```

Example Zed custom agent shape (stable):

```json
{
  "agent_servers": {
    "Google Antigravity": {
      "command": "npx",
      "args": ["-y", "agy-acp"],
      "env": {
        "PATH": "/path/to/agy/bin" // Optional
      }
    }
  }
}
```

Alpha pre-release channel (draft ACP v2 iteration):

```json
{
  "agent_servers": {
    "Google Antigravity (alpha)": {
      "command": "npx",
      "args": ["-y", "agy-acp@alpha"]
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
- `AGY_ACP_MODE`: default execution mode for new sessions (`default`,
  `accept-edits`, or `plan`). Overridden by the session Mode picker or the
  `agy-acp --mode <value>` argv flag.
- `AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS`: when set, passes
  `--dangerously-skip-permissions` to `agy` (auto-approve tool permissions).

### File writes denied in Zed?

Under `agy --print` (agy ≥ 1.1.3), tools that need interactive confirmation are
**soft-denied** rather than prompting a TTY. Messages like
`User denied permission for write_file(...)` usually mean agy refused the tool —
not that the ACP client blocked the editor filesystem.

Workarounds (prefer earlier ones):

1. Set session **Mode** to **Accept Edits** (`accept-edits`), or start with
   `AGY_ACP_MODE=accept-edits` / `agy-acp --mode accept-edits`.
2. Allowlist tools in `~/.gemini/antigravity-cli/settings.json` under
   `permission.allow` (agy honors this in print mode as of 1.1.1–1.1.4).
3. Opt in to `AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS=1` or
   `--dangerously-skip-permissions` (broad auto-approve).

True interactive `session/request_permission` (Zed Allow/Deny dialogs feeding
agy) is **not** implemented: agy decides permissions inside `--print` with no
external pause/resume API. See the roadmap.

## Model Picker

When the ACP client supports session configuration options, `agy-acp` returns
three options during `session/new` (this order). Wire **ids** are stable;
**names** are human-facing labels in the client UI:

| Order | id | name | Category |
|---|---|---|---|
| 1 | `mode` | Mode | `mode` |
| 2 | `model` | Model | `model` |
| 3 | `reasoningEffort` | Reasoning Effort | `thought_level` |

`mode` values:

- `default` — agy request-review behavior (omits `--mode`; write tools may soft-deny under `--print`)
- `accept-edits` — `agy --mode accept-edits` (apply file edits without interactive write review)
- `plan` — `agy --mode plan`

`reasoningEffort` maps to `agy --effort`.

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

## ACP v1 roadmap

`agy-acp` covers the core ACP prompt loop (sessions, config options, streamed
tool calls, edit diffs, load/resume). Gaps below are relative to ACP v1 as
exposed by `@agentclientprotocol/sdk` and are ordered by practical editor UX.
Several items are constrained by wrapping `agy --print` and polling its
conversation database rather than driving agy as a full interactive agent.

### Done

- [x] `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/close`
- [x] `session/load` and `session/resume` with persisted bindings
- [x] `session/set_config_option` (`mode`, `model`, `reasoningEffort`)
- [x] `additionalDirectories` → `agy --add-dir`
- [x] Prompt content: text, image, embedded resource, resource link (`audio: false`)
- [x] Streamed `session/update`: `agent_message_chunk`, `agent_thought_chunk`,
      `user_message_chunk` (replay), progressive `tool_call` / `tool_call_update`,
      `session_info_update`
- [x] Tool kinds, locations, `rawInput` / `rawOutput`, edit content type `diff`
- [x] `session/list` from the session store
- [x] Execute tool output when present in the conversation DB (field 28)
- [x] Decode/show fetch and web-search result bodies when present in the DB
      (search_web hit lists are not persisted by agy; query metadata only)
- [x] Full-file write diffs with prior content when known from earlier view/write steps
- [x] Permission notes map decision varint to granted/denied labels (still not interactive)

### High priority

These need more than conversation-DB polling (interactive agy control plane or
client terminal protocol) and are **out of scope for 0.2.x fidelity patches**:

- [ ] Interactive `session/request_permission` (today: post-hoc granted/denied text;
      agy still owns allow/deny under `--print`)
- [ ] Structured `plan` / `plan_update` / `plan_removed` (today: brain/plan files are
      prose tool content with Plan titles — not ACP plan updates)
- [ ] Client terminals: `type: "terminal"` content + `terminal/*` (today: execute tools
      show command + captured output as content blocks, not live terminal protocol)
- [ ] ACP elicitation for `ask_question` (today: static tool_call text options)
- [ ] MCP: honor `session/new` `mcpServers` and advertise real `mcpCapabilities`
      (today: all MCP caps are `false` and servers are ignored)

### Medium priority

- [ ] Optional `session/delete` from the session store
- [ ] `session/fork` if/when useful for clients
- [ ] Native ACP session modes (`session/set_mode`, `modes`, `current_mode_update`)
      in addition to the `mode` config option that already maps to `agy --mode`
- [ ] `available_commands_update` for slash-command discovery in the client UI
- [ ] Push `config_option_update` when options change outside `set_config_option`
- [ ] `authenticate` / `logout` / `authMethods` (today: require a pre-logged-in `agy`)
- [ ] `usage_update` and prompt-response `usage` when token data is available
- [ ] Richer `stopReason` values (`max_tokens`, `refusal`, `max_turn_requests`) when
      agy exposes them (today: `end_turn` or `cancelled`)

### Fidelity improvements

- [x] Surface command stdout/stderr on execute tool calls when present in the DB
- [x] Decode/show fetch and web-search result bodies (not just URL / title)
- [x] Better diffs for full-file writes when prior content is knowable
- [x] Map permission decisions into granted/denied labels (not interactive outcomes)
- [ ] Agent-outbound images / richer content blocks when agy produces them

### Lower priority / unstable ACP

Usually skip unless a client needs them for this wrapper:

- [ ] `providers/*` (LLM provider routing UI)
- [ ] `nes/*` (next-edit suggestions)
- [ ] `document/*` (editor document sync)
- [ ] Agent-driven client `fs/read_text_file` / `fs/write_text_file` (agy does FS itself)
- [ ] Non-stdio transports (HTTP / WebSocket) — stdio NDJSON is intentional for Zed

## Development

Run the TypeScript tests:

```sh
npm test
```

Smoke-test the ACP initialize handshake:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | node dist/main.js
```

## Important Disclaimer & Legal Notice

**This project is an unofficial community adapter** that bridges the official [Google Antigravity CLI (`agy`)](https://antigravity.google/product/antigravity-cli) with the [Agent Client Protocol (ACP)](https://agentclientprotocol.com).

**Use at your own risk.**

Google explicitly discourages third-party tools like this one. From their FAQ:

> Using third party software, tools, or services to access Antigravity is a violation of our [Terms of Service](https://antigravity.google/terms), and severely degrades the experience for legitimate product users. Such actions may be grounds for suspension or termination of your account. If you would like to use a third party coding agent with Gemini, we recommend using a Vertex or AI Studio API key.

### Recommendations
- Use this adapter **only on test / secondary Google accounts**.
- For lower-risk or production use, prefer official Google Vertex AI / AI Studio API keys with native ACP-compatible agents.
- Monitor your account health and stop usage immediately if you notice any warnings.

This project is provided **as-is** with no warranty. The maintainer(s) are not responsible for any account actions, restrictions, or consequences from using this software.

By using `agy-acp`, you acknowledge that you have read and agree to both this disclaimer and Google's Terms of Service.