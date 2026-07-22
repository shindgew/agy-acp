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

## Releasing

Pushing a version tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml),
which runs the test suite, creates a GitHub Release, and publishes to npm.

One-time setup: store an npm automation token as the repository secret
`NPM_TOKEN` (Settings → Secrets and variables → Actions).

Release checklist:

1. Update `CHANGELOG.md` with a `## [X.Y.Z] - YYYY-MM-DD` section (move items
   out of `[Unreleased]`).
2. Bump `version` in `package.json` and `package-lock.json` to `X.Y.Z`.
3. Commit on `main` (for example `Release X.Y.Z`).
4. Tag and push:

```sh
git tag -a "vX.Y.Z" -m "Release X.Y.Z"
git push origin main "vX.Y.Z"
```

The tag must be `v` plus the exact `package.json` version (for example
`v0.2.5` for `"version": "0.2.5"`). Do not publish to npm locally; let CI own
the publish so the GitHub Release and npm version stay in lockstep.
