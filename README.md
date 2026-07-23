# agy-acp

ACP adapter for Google Antigravity's `agy` CLI. TypeScript, `npx`-runnable, built on
`@agentclientprotocol/sdk`. Runs a persistent interactive `agy` process so ACP clients
can answer permission requests while keeping the logged-in Antigravity CLI experience.

**Package:** `0.3.0` (`latest`) — ACP v1 + experimental draft ACP v2 via `initialize`
negotiation. Draft v2 continues on the `alpha` dist-tag (`1.0.0-alpha.*`). See the
[ACP v2 draft](https://agentclientprotocol.com/announcements/acp-v2-draft) and
[migration guide](https://agentclientprotocol.com/protocol/v2/migration). Requires
**Node.js 22+**.

## Usage

If `agy` is missing from `PATH`, `agy-acp` installs it during `initialize` from
[google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli/releases/latest)
into `~/.local/bin/agy` (checksum-verified when GitHub publishes a digest). Or install yourself:

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

```sh
npx agy-acp                 # stable (0.3.0)
npx agy-acp@alpha           # draft ACP v2 channel
npx agy-acp@1.0.0-alpha.0   # pin a pre-release
```

Zed custom agent (stable):

```json
{
  "agent_servers": {
    "Google Antigravity": {
      "command": "npx",
      "args": ["-y", "agy-acp"],
      "env": {
        "PATH": "/path/to/agy/bin"
      }
    }
  }
}
```

Alpha (draft ACP v2):

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

**Unofficial community adapter.** Bridges the official
[Google Antigravity CLI](https://antigravity.google/product/antigravity-cli) with
[ACP](https://agentclientprotocol.com). **Use at your own risk.**

Google's FAQ states that third-party tools to access Antigravity violate their
[Terms of Service](https://antigravity.google/terms) and may lead to account suspension.
Prefer Vertex / AI Studio API keys for lower-risk use. Use this only on test/secondary
accounts.

Provided as-is, no warranty. By using `agy-acp` you accept this notice and Google's ToS.
