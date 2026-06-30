# Security Policy

## Supported Versions

`agy-acp` is pre-1.0 software. Security fixes are provided for the latest
released version only.

## Reporting a Vulnerability

Please do not report suspected vulnerabilities in public issues.

Use GitHub private vulnerability reporting for this repository when available.
If private reporting is not enabled, open a public issue asking for a private
contact path without including exploit details, credentials, logs, or workspace
contents.

Include enough information to reproduce the issue safely:

- affected `agy-acp` version or commit;
- operating system and Node.js version;
- ACP client and `agy` CLI version/path;
- relevant `AGY_ACP_*` configuration;
- a minimal reproduction that avoids secrets and private source code.

## Security Model

`agy-acp` runs as an ACP stdio server and starts `agy --print` subprocesses
inside the workspace provided by the ACP client. The `agy` CLI may read files,
edit files, or run commands according to its own runtime policy.

`--sandbox` is enabled by default. Do not set
`AGY_ACP_AGY_SKIP_PERMISSIONS=1` outside a trusted workspace. The optional
`AGY_ACP_AUTO_INSTALL_AGY=1` path runs a shell installer command, so only enable
it in environments where bootstrapping the latest Antigravity CLI is expected.

Never share API keys, credentials, private source code, or confidential logs in
public issues or pull requests.
