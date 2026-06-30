# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning before `1.0.0` with the usual
pre-1.0 caveat that minor versions may include breaking changes.

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
