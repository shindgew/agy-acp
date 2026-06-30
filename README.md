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
  -> AgyCliBackend
  -> agy --print --sandbox ...
```

The ACP SDK layer owns protocol parsing, validation, JSON-RPC framing, and
client notifications. The adapter owns sessions, prompt conversion,
cancellation, and `session/update` streaming. The backend owns only `agy`
process execution.

The first backend is intentionally conservative:

- one `agy --print` subprocess per ACP prompt,
- separate ACP session `Model` and `Reasoning Effect` pickers populated from
  `agy models` when available,
- an ACP session `Fast Mode` selector that prepends `/fast` to print-mode
  prompts without editing global Antigravity settings,
- stdout chunks become ACP `agent_message_chunk` updates, with recognized
  thinking/progress lines surfaced as a visible ACP `think` tool call,
- cancellation sends `SIGTERM`, then `SIGKILL` if the process does not exit,
- `--sandbox` is enabled by default,
- `--dangerously-skip-permissions` is opt-in only.

This avoids scraping an interactive terminal UI. Conversation continuity via
`--conversation` can be added later if the CLI exposes a stable conversation ID
that can be scoped per ACP session.

## Run

Install the Antigravity CLI first. The installer fetches the latest release when
`agy` is not already installed; existing installs are left in place because the
CLI self-updates during normal use.

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
        "AGY_ACP_AGY_PATH": "/opt/homebrew/bin/agy"
      }
    }
  }
}
```

Optional environment variable:

- `AGY_ACP_AGY_PATH`: path to `agy`, default `agy`. Set this in Zed when the
  agent process does not inherit your shell `PATH`.

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

Enabling `Fast Mode` sends `/fast` before the user prompt in the transient
`agy --print` session. This mirrors Antigravity CLI Fast Mode without mutating
`~/.gemini/antigravity-cli/settings.json`.

## Development

Run the TypeScript tests:

```sh
npm test
```

Smoke-test the ACP initialize handshake:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | node dist/cli.js
```
