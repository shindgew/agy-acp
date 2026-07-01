# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning before `1.0.0` with the usual
pre-1.0 caveat that minor versions may include breaking changes.

## [Unreleased]

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
