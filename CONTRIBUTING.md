# Contributing

Thanks for improving `agy-acp`.

## Development Setup

Use Node.js 22 or newer.

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

**Only tags whose commit is already on `main` are released.** Tagging a
feature-branch tip fails the workflow and does not publish. Merging a PR alone
does not publish; you must push a tag after the release commit is on `main`.

| Tag example | GitHub | npm dist-tag | Install |
|-------------|--------|--------------|---------|
| `v0.2.5` | Full release | `latest` | `npx agy-acp` |
| `v1.0.0-alpha.0` | **Pre-release** | `alpha` | `npx agy-acp@alpha` or `@1.0.0-alpha.0` |
| `v1.0.0-beta.1` | **Pre-release** | `beta` | `npx agy-acp@beta` |
| `v1.0.0-rc.1` | **Pre-release** | `rc` | `npx agy-acp@rc` |

The npm dist-tag is the first segment of the SemVer pre-release id
(`1.0.0-alpha.0` → `alpha`). Stable versions (no hyphen) publish as `latest`.
Bare `npx agy-acp` always follows `latest`, so alphas never become default.

One-time setup (npm **Trusted Publisher**, no long-lived token):

1. On [npmjs.com](https://www.npmjs.com) → package `agy-acp` → **Trusted Publisher**.
2. Provider: **GitHub Actions**.
3. Organization / user: `shindgew`, repository: `agy-acp`.
4. Workflow filename: `release.yml` (must match `.github/workflows/release.yml`).
5. Leave environment empty unless you add a GitHub Environment to the job.

The release workflow uses OIDC (`permissions: id-token: write`) and
`npm publish --provenance`. Do **not** set `NPM_TOKEN` for publish.

### Stable release checklist

1. Update `CHANGELOG.md` with a `## [X.Y.Z] - YYYY-MM-DD` section (move items
   out of `[Unreleased]`).
2. Bump `version` in `package.json` and `package-lock.json` to `X.Y.Z`.
3. Land that commit on `main` (merge PR or push).
4. Tag **that** commit and push the tag:

```sh
git checkout main
git pull origin main
git tag -a "vX.Y.Z" -m "Release X.Y.Z"
git push origin "vX.Y.Z"
```

### Pre-release (alpha / beta / rc) checklist

1. Update `CHANGELOG.md` with a `## [X.Y.Z-alpha.N] - YYYY-MM-DD` section.
2. Bump `version` in `package.json` and `package-lock.json` to that pre-release
   (for example `1.0.0-alpha.0`).
3. Land that commit on `main` (merge PR or push).
4. Tag **that** commit and push the tag:

```sh
git checkout main
git pull origin main
git tag -a "v1.0.0-alpha.0" -m "Release 1.0.0-alpha.0"
git push origin "v1.0.0-alpha.0"
```

CI marks the GitHub Release as a pre-release and runs
`npm publish --tag alpha` (or `beta` / `rc` as above).

The tag must be `v` plus the exact `package.json` version (for example
`v0.2.5` for `"version": "0.2.5"`, or `v1.0.0-alpha.0` for
`"version": "1.0.0-alpha.0"`). Do not publish to npm locally; let CI own the
publish so the GitHub Release and npm version stay in lockstep.
