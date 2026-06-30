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
- stdout chunks become ACP `agent_message_chunk` updates,
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

Useful environment variables:

- `AGY_ACP_AGY_PATH`: path to `agy`, default `agy`.
- `AGY_ACP_MODEL`: initial model selection, passed through as `agy --model`
  after the session model picker selects it.
- `AGY_ACP_MODELS`: comma- or newline-separated model list override for the
  dynamic ACP model picker.
- `AGY_ACP_DISCOVER_MODELS`: defaults to `1`; set `0`/`false` to skip
  `agy models` discovery and use only `AGY_ACP_MODELS`/`AGY_ACP_MODEL`.
- `AGY_ACP_MODEL_LIST_TIMEOUT_MS`: timeout for `agy models`, default `15000`.
- `AGY_ACP_FAST_MODE`: defaults to `0`; set `1` to enable the initial
  session `Fast Mode` selector.
- `AGY_ACP_PROJECT`: passed through as `agy --project`.
- `AGY_ACP_AGY_PRINT_TIMEOUT`: passed through as `agy --print-timeout`, default `5m0s`.
- `AGY_ACP_AGY_SANDBOX`: defaults to `1`; set `0`/`false` to omit `--sandbox`.
- `AGY_ACP_AGY_SKIP_PERMISSIONS`: set `1` only when you explicitly want `--dangerously-skip-permissions`.
- `AGY_ACP_AGY_LOG_FILE`: passed through as `agy --log-file`.
- `AGY_ACP_AGY_PROMPT_IN_ARGV`: defaults to `1`; set `0` to send the prompt on stdin instead of argv.
- `AGY_ACP_AUTO_INSTALL_AGY`: defaults to `0`; set `1` to let `agy-acp`
  run the official installer once when the default `agy` executable is missing.
- `AGY_ACP_AGY_INSTALL_COMMAND`: installer shell command used by
  `AGY_ACP_AUTO_INSTALL_AGY`, default
  `curl -fsSL https://antigravity.google/cli/install.sh | bash`.
- `AGY_ACP_AGY_INSTALL_BIN_DIR`: directory prepended to `PATH` after an
  opt-in install succeeds, default `$HOME/.local/bin`.

`agy-acp` does not install or update `agy` by default. The opt-in installer is
intended for container and ephemeral agent environments where pulling the latest
Antigravity CLI during startup is expected.

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

The first discovered model is selected by default when `AGY_ACP_MODEL` is unset.
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
