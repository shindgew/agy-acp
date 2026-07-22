# Contributing

Thanks for improving `agy-acp`.

## Development Setup

Use Node.js 20 or newer.

```sh
npm test
```

## Verification

Run the same checks used by CI before opening a pull request:

```sh
npm run build
npm test
node --check dist/main.js
node --check dist/acp-server.js
node --check dist/cli.js
```

## Pull Requests

- Keep changes focused and explain the behavior being changed.
- Add or update tests for protocol mappings, lifecycle behavior, CLI process
  handling, and startup behavior.
- Do not commit generated build output, API keys, logs, or local Antigravity
  runtime state.
- Keep `agy` installation and permission-bypass behavior opt-in. Changes that
  broaden tool execution or workspace access need tests and security notes.

## Dependency Updates

When changing the `agy` command-line flags or minimum Node version, verify the
stdio `initialize` path and at least one real session with an ACP client.
