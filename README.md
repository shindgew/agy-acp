<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/header-image-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/header-image-light.png">
    <img alt="agy-acp" src="docs/assets/header-image-light.png">
  </picture>
  <br>
  agy-acp
</h1>

[ACP](https://agentclientprotocol.com) adapter for [Google Antigravity CLI](https://antigravity.google/product/antigravity-cli)

</div>


## Usage

`agy-acp` automatically uses an installed `agy` binary if it exists and no binary is explicitly specified. If no existing binary is detected or specified, it installs the latest version during `initialize` from the official [google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli/releases/latest) GitHub repository into `~/.local/bin/agy` (checksum-verified when a digest is published).

Or install `agy` yourself using the official installer script or Homebrew:

```sh
# Official script
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Homebrew
brew install antigravity-cli
```

### Zed Configuration

Add `agy-acp` as a custom agent in Zed:

```json
{
  "agent_servers": {
    "Google Antigravity": {
      "command": "npx",
      "args": ["agy-acp"]
    }
  }
}
```

### Environment

| Variable | Default / notes |
|---|---|
| `PATH` | Must include `agy` if the editor doesn't inherit your shell `PATH` |
| `AGY_ACP_CONVERSATIONS_DIR` | `~/.gemini/antigravity-cli/conversations` |
| `AGY_ACP_STATE_DIR` | `~/.agy-acp-state` (session bindings for load/resume) |
| `AGY_ACP_MODE` | `default` · `accept-edits` · `plan` |
| `AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS` | Auto-approve tools; switches to non-interactive print mode |
| `AGY_ACP_INTERACTIVE_PERMISSIONS=0` | Disable permission bridge (print mode, no auto-approve). Flag: `--no-interactive-permissions` |

## Architecture

```text
Zed / ACP client
  -> agy-acp (v1 or draft v2 from initialize)
  -> AcpAgent (sessions, config, prompt lifecycle)
  -> AgyCliSession (interactive agy PTY, --conversation id)
  -> agy --prompt-interactive ... --conversation <id> --sandbox ...
       \-> ~/.gemini/antigravity-cli/conversations/<id>.db
  -> StreamPoller + Translator -> ACP session/update notifications
```

- One interactive `agy` PTY per ACP session; conversation id is learned on the first turn
  and reused. PTY output is a diagnostic tail only — never parsed as agent text.
- Steps come from agy's conversation SQLite DB (structured protobuf records), not stdout.
- Config options: `mode` → `--mode`, `model` → `--model`, `reasoningEffort` → `--effort`
- Cancel: `SIGINT` then `SIGKILL`. `--sandbox` on by default; skip-permissions is opt-in.
- Session bindings persist under `AGY_ACP_STATE_DIR` so list/load/resume survive restarts.
- **v1:** `session/load` replays history; `session/resume` reattaches without replay.
  **v2:** only `session/resume` — pass `replayFrom: { "type": "start" }` to replay.

### Queued follow-ups and steering

`agy-acp` supports an opt-in extension for overlapping `session/prompt` requests:

```json
{
  "_meta": { "agy-acp/turnIntent": "queue" }
}
```

`queue` stores the prompt in a per-session FIFO and runs it after the active
turn reaches idle. Use `"steer"` instead to cancel the active turn, wait for
its process and conversation writes to settle, and then run the new prompt.
Steering is cancellation followed by a replacement turn, not modification of
an in-flight model request. Prompts without `turnIntent` retain standard ACP
overlap behavior and are rejected.

Queued v1 prompts resolve with `stopReason: "cancelled"` when cancelled or when
their session closes/deletes. Queued v2 prompts emit `state_update` with
`state: "idle"` and `stopReason: "cancelled"`.

Wire format decoding was cross-referenced with
[shubzkothekar/antigravity-acp](https://github.com/shubzkothekar/antigravity-acp) (MIT);
decoding code is our own.

## Development

```sh
npm run build && npm test
node dist/main.js

# smoke initialize
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | node dist/main.js
```

See [ROADMAP.md](./ROADMAP.md) for ACP coverage and planned work.

## Disclaimer

Google's FAQ states that third-party tools to access Antigravity violate their
[Terms of Service](https://antigravity.google/terms) and may lead to account suspension.  
Prefer Vertex / AI Studio API keys for lower-risk use. Use this only on test/secondary
accounts.  

Provided as-is, no warranty. By using `agy-acp` you accept this notice and Google's ToS.  

**Use at your own risk.**