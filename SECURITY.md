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
- `PATH` when customized for the agent process;
- a minimal reproduction that avoids secrets and private source code.

## Security Model

`agy-acp` runs as an ACP stdio server and starts `agy --print` subprocesses
inside the workspace provided by the ACP client. The `agy` CLI may read files,
edit files, or run commands according to its own runtime policy.

`--sandbox` is enabled by default and `--dangerously-skip-permissions` is not
used by this adapter.

Never share API keys, credentials, private source code, or confidential logs in
public issues or pull requests.
