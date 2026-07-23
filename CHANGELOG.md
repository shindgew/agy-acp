# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning. Pre-1.0 releases used the usual
pre-1.0 caveat that minor versions may include breaking changes. Starting with
`1.0.0-alpha.0`, package pre-releases track ACP v2 draft work; the wire protocol
for draft v2 may still change before ACP v2 stabilizes.

## [Unreleased]

### Added

- Draft ACP v2 agent-owned terminals for `run_command` / execute tools: emit
  `terminal_update` (command, cwd, base64 output snapshot, exit status) and
  embed `{ type: "terminal", terminalId }` on the tool call. v1 clients keep
  command/output content blocks. Client-executed v1 `terminal/*` is still not
  used (agy runs the shell; re-running via the editor would double-execute).
- Structured ACP plans from agy brain markdown artifacts: emit classic v1
  `sessionUpdate: "plan"` with entries parsed from lists/checkboxes, and map
  to draft-v2 `plan_update` (`type: "markdown"` when the body is known, else
  `type: "items"`). Replaces the previous Plan-titled prose tool_call for those
  writes. No `plan_removed` and no live step status beyond checkbox markers.
- Native ACP v1 session modes: advertise `modes` on `session/new`, `session/load`,
  and `session/resume`, and handle `session/set_mode` for the same three ids as
  the `mode` config option (`default` / `accept-edits` / `plan` → `agy --mode`).
- Dual-sync mode surfaces: `session/set_mode` pushes `current_mode_update` and
  `config_option_update`; changing `mode` via `session/set_config_option` pushes
  `current_mode_update` so native mode UIs stay aligned.
- Curated ACP slash commands via `available_commands_update` on
  `session/new` / `session/load` / `session/resume`: `mode`, `plan`, `model`,
  and `effort`. Matching `session/prompt` text (for example `/mode plan`) is
  applied as session config without spawning agy. Full agy TUI slash menus are
  not advertised.
- ACP authentication MVP: `authMethods` (terminal `agy-login` with
  `agy-acp --login` for Google AI Pro web/API-key TUI, plus agent status probe),
  v1 `authenticate` / `logout` and v2 `auth/login` / `auth/logout`,
  `agentCapabilities.auth.logout`, and `auth_required` when `session/new` (and
  load/resume) runs without a signed-in agy. Logout sends TUI `/logout` over a
  short-lived PTY.

### Changed

- Source layout follows ACP protocol sections: `content/`, `session/`,
  `slash-commands/`, `tool-calls/`, `file-system/`, `agent-plan/`, with the
  Antigravity backend under `agy/` and the dual-protocol agent in `agent.ts`.
- Internal names aligned with ACP: `AcpAgent` / `AcpAgentOptions`,
  `reasoningEffort` (was internal `reasoningEffect`),
  `additionalDirectories` (was `workspaces`), `SessionModeId`,
  `ClientFileSystem`, `contentBlocksToPrompt`, and related helpers. Session
  store still loads legacy keys (`workspaces`, `reasoningEffect`, `modelId`).
- Package `main` / `types` entry is `dist/agent.js` (was `dist/acp-server.js`).
- ROADMAP expanded against the full ACP schema (not only overviews), with doc
  links on protocol items.

### Removed

- Thin re-export barrels (`acp-server.ts` shim and unused section `index.ts`
  files) and deprecated `AcpAgent` aliases (`initialize`, `newSession`,
  `resumeSession`, `setConfigOption`, `prompt` without a v1/v2 suffix).

## [0.2.8] - 2026-07-22

Broader interactive permission bridge: file tools and single-select
`ask_question` can be answered through ACP clients.

### Changed

- Interactive permission bridge now covers file tools that share agy's
  four-choice ToolConfirmationPanel (`write_to_file`, `replace_file_content`,
  `multi_replace_file_content`, `view_file`, `list_dir`) in addition to
  `run_command`.
- Single-select, single-question `ask_question` is bridged through
  `session/request_permission` (one option per choice + Skip). Multi-select
  and multi-question forms still fail closed without writing PTY keys.
- File-edit permissions use **standard ACP** option ids/kinds
  (`allow-once` / `allow-always` / `reject-once`) so clients can map them to
  native Keep / Reject UI, while still driving agy's TUI via PTY keys.

## [0.2.7] - 2026-07-22

Session config aligned with Antigravity CLI 1.1.x, plus an experimental
interactive permission bridge for `run_command`. Prefer **agy ≥ 1.1.5** for
modes, stable model slugs, `--effort`, and the bridged permission menu.

### Added

- ACP session `mode` config option mapped to `agy --mode`:
  `default` (omit flag), `accept-edits`, and `plan`. Persisted on load/resume,
  overridable via `AGY_ACP_MODE` or `agy-acp --mode <value>`.
- Experimental persistent-PTY permission bridge (default path). ACP clients can
  allow once, allow for the persistent conversation, always allow via
  `settings.json`, or reject once. Cancellation and model/mode changes restart
  the PTY and reset conversation-scoped grants. Only the observed four-choice
  `run_command` menu is bridged; other status-9 interactions fail closed without
  writing PTY menu keys. `--dangerously-skip-permissions` selects non-interactive
  print mode; `AGY_ACP_INTERACTIVE_PERMISSIONS=0` /
  `--no-interactive-permissions` also use print mode without auto-approval.
- `node-pty` dependency for the interactive path, with platform smoke coverage.

### Changed

- Session config option **ids** and order are now `mode`, `model`,
  `reasoningEffort` (was `model`, `effort`, and previously `fast-mode`).
  Display **names** are `Mode`, `Model`, `Reasoning Effort`.
  `reasoningEffort` still maps to `agy --effort`.
- Session store fields renamed to match: `model` / `reasoningEffort` (legacy
  `modelId` / `reasoningEffect` still load).
- Default execution path uses interactive `agy --prompt-interactive` via a
  persistent PTY when the permission bridge is enabled; print mode remains
  available for the bypasses above.
- README documents Mode / allowlist / skip-permissions workarounds and the
  interactive bridge limits.

### Removed

- ACP session `Fast Mode` config option (`fast-mode` / `/fast` prompt prefix).
  Antigravity CLI removed `/fast` slash commands in `agy` 1.1.0 in favor of
  execution mode cycling (`default` → `accept-edits` → `plan`).

## [0.2.6] - 2026-07-22

Stable ACP v1 fidelity release: richer tool result bodies and better editor diffs,
without interactive permission / terminal / MCP control-plane work (still blocked
on wrapping `agy --print`).

### Added

- Decode `search_web` result metadata (step field 42): query and refined query /
  search URL when present. Hit lists are not persisted by agy.
- Decode `read_url_content` results (step field 40): URL, title, description, and
  body text (truncated for display) plus optional brain `contentPath`.
- Full-file write diffs use prior `view_file` / write content as `oldText` when
  the same translator pass has seen that path (stream + full replay).

### Changed

- Permission notes label outcomes from the decision varint (`granted` / `denied`
  instead of only “requested”).
- Brain plan artifact writes use clearer `Plan:` titles when the filename does
  not already contain “plan”.
- Fetch titles prefer the URL when agy only stores the generic “Live Content”
  label; full-file write cache ignores ranged `view_file` slices.

## [0.2.5] - 2026-07-22

Stable release focused on ACP v1 editor UX. Dual-protocol draft ACP v2 support
from the `1.0.0-alpha.0` line is included when clients negotiate protocol
version 2; default `npx agy-acp` clients continue to use ACP v1.

### Added

- Progressive tool lifecycle: stream polls re-read in-flight steps and emit
  `tool_call` on first sight, then `tool_call_update` when status or content
  changes (pending / in_progress → completed / failed / cancelled).
- Real `agent_thought_chunk` for title-attached “Think” narration and think-style
  tool names (replacing fake `tool_call` kind `think` for those paths).
- Decode `run_command` result payload (step field 28) and surface command
  stdout/stderr text plus `rawOutput.exitCode` on execute tool calls.
- `session/list` coverage and docs (implementation already present).

### Changed

- Title-step “Think” blocks no longer re-emit on every stream poll.

## [1.0.0-alpha.0] - 2026-07-22

Pre-release: dual ACP **v1** + experimental draft **v2** support.

### Added

- Dual-protocol router (`agentProtocolRouter`) negotiates ACP v1 or draft v2 from
  the client's `initialize.protocolVersion`. Runtime entry (`runAcp`) serves both.
- Experimental draft ACP v2 surface via `@agentclientprotocol/sdk/experimental/v2`:
  - Role-agnostic `info` / `capabilities` on initialize
  - Baseline session methods including required `session/list`
  - Prompt lifecycle: immediate `{}` acceptance, `user_message` ack with
    `messageId`, `state_update` (`running` / `idle` + `stopReason`)
  - `session/resume` with optional `replayFrom: { "type": "start" }` (replaces
    v1 `session/load` for v2 peers)
  - `tool_call` → `tool_call_update`, structured diff `changes` + optional
    `git_patch`, required message IDs on message chunks
  - Config options use `configId` (v1 still uses `id`)
- `session/list` on both protocol versions (backed by the session store).
- Release workflow support for SemVer pre-releases (`alpha` / `beta` / `rc`):
  GitHub pre-release + matching npm dist-tag; only tags on `main` publish.

### Changed

- Bumped `@agentclientprotocol/sdk` to `^1.3.0`.
- Package version is `1.0.0-alpha.0` for the ACP v2 pre-release track.

## [0.2.4] - 2026-07-22

### Changed

- Renamed source modules for clarity: `src/agy-db/` → `src/db/`,
  `src/agy-cli.ts` → `src/cli.ts`, `src/agy-installer.ts` → `src/installer.ts`.
  The package bin entry is now `dist/main.js` (was `dist/cli.js`).
- Model discovery matches Antigravity CLI ≥1.1.5: parse stable slugs from
  `agy models` (e.g. `gemini-3.5-flash-medium`), group by base model, and pass
  reasoning effort via the separate `agy --effort` flag instead of embedding
  `(Medium)` in `--model`. Thinking models (`*-thinking`) stay whole-model
  identities. Legacy display-name lists remain supported.

## [0.2.3] - 2026-07-01

Published as `0.2.3` because npm permanently blocks republishing a version
number after it has been published, even if that release is later
unpublished.

### Added

- `agy-acp` command-line flags `--no-sandbox`, `--sandbox`, and
  `--dangerously-skip-permissions`, plus `AGY_ACP_SANDBOX`, `AGY_ACP_NO_SANDBOX`,
  and `AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS` environment-variable overrides.

### Changed

- Pass `--add-dir` for every ACP workspace, including the primary `cwd`, so
  `agy --sandbox` runs commands in the Zed project instead of the internal
  scratch directory.
- ACP `model` config values now use lowercase hyphenated slugs (for example
  `gemini-3.5-flash`) and `effort` values use lowercase (`low`, `medium`,
  `high`), while picker labels stay human-readable (`Gemini 3.5 Flash`,
  `Medium`, `N/A`, and so on). `agy --model` still receives agy's native
  display names internally.
- Persisted sessions with legacy capitalized model or effort values are
  normalized on `session/load` and `session/resume`.

### Fixed

- Platform smoke workflow now uses the standard `macos-15-intel` runner instead
  of the unavailable `macos-14-large` paid runner.

## [0.2.2] - 2026-07-01

Git tag only. An npm release was briefly published and then unpublished; npm
does not allow that version number to be reused. Use `0.2.3` on npm instead.

## [0.2.1] - 2026-07-01

### Added

- Automatic `agy` installation during `initialize` when no executable is found
  on `PATH`. Downloads the platform-matching asset from
  `google-antigravity/antigravity-cli` GitHub Releases (latest), verifies the
  published SHA256 digest when available, installs to `~/.local/bin/agy`, and
  prepends that directory to `PATH`.
- Platform smoke CI workflow and `scripts/smoke-install.mjs` for cross-OS
  install and ACP `initialize` verification.

### Breaking

- Removed `AGY_ACP_AGY_PATH`. Point `agy` via the standard `PATH` environment
  variable instead.

### Changed

- Prompt-time auto-install now uses the same GitHub Releases installer instead
  of the legacy `curl | bash` script.

## [0.2.0] - 2026-07-01

### Added

- `session/load` and `session/resume` support, backed by a persisted session
  store (`AGY_ACP_STATE_DIR`, default `~/.agy-acp-state`) and an incremental
  conversation-replay cache.
- Structured ACP streaming from agy's conversation database: real
  `tool_call` / `tool_call_update` events, `session_info_update` titles, and
  agent text deltas decoded from protobuf step records.
- `AGY_ACP_CONVERSATIONS_DIR` environment variable to override where `agy`'s
  conversation databases are read from.
- `better-sqlite3` and `@bufbuild/protobuf` dependencies for read-only
  conversation-database access and step-payload decoding.

### Changed

- Replaced `agy --print` stdout scraping (regex-based "thinking" line
  detection) with direct reads of `agy`'s per-conversation SQLite database.
  Prompts now run with `--conversation <id>` for continuity, and a poller
  translates decoded, structured conversation steps into ACP updates instead
  of guessing at plain text.
- Cancellation now sends `SIGINT` (falling back to an ungraceful kill on
  Windows) instead of `SIGTERM`, so `agy` can flush its conversation database
  before exiting.
- `loadSession` is now advertised as `true`.

### Breaking

- ACP session config option ids renamed: `agy.model` → `model`,
  `agy.reasoning_effect` → `effort`, `agy.fast_mode` → `fast-mode`.
- Prompt turns are now conversation-bound across ACP prompts in the same
  session; 0.1.0 treated every prompt as a fresh `agy --print` invocation with
  no `--conversation` continuity.

## [0.1.0] - 2026-07-01

### Added

- Initial ACP stdio adapter for Google Antigravity.
- TypeScript ACP server built on `@agentclientprotocol/sdk` that wraps
  `agy --print`.
- One `agy --print` subprocess per ACP prompt.
- Dynamic ACP session model picker backed by `agy models`, with flat
  Zed-compatible option labels split by reasoning suffix (`Low`, `Medium`,
  `High`) and static env
  overrides for clients or environments that cannot discover models.
- ACP session Fast Mode selector that sends `/fast` in transient print-mode
  sessions.
- Text prompt conversion, stdout streaming, cancellation, and session lifecycle
  handling.
- Safe CLI defaults with `--sandbox` enabled and permission bypass opt-in only.
- Opt-in missing-`agy` installer hook for container and ephemeral environments.
- Post-install `PATH` handling for the official installer default of
  `$HOME/.local/bin`.
- `dist/` build and npm package entrypoint, matching TypeScript ACP adapter
  packaging patterns.
- Unit tests and initialize smoke-test guidance.
