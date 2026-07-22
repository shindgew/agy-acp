#!/usr/bin/env node
// Exercises a built `agy-acp` CLI exactly as a real ACP client would: spawn
// it, speak ND-JSON over its actual stdio, and complete `initialize`. This
// is the one check that forces Node to `require("better-sqlite3")` through
// the platform's real prebuilt (or compiled) native binary, which is the
// part that can silently break per OS/arch and unit tests never spawn a
// subprocess for.
//
// A stub `agy` is injected on PATH so initialize does not network-download
// the real CLI (that was flaky / slow on some runners and is not what this
// smoke test is measuring).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { client as acpClient, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const cliPath = process.argv[2];
if (!cliPath) {
  console.error("usage: smoke-install.mjs <path-to-cli.js>");
  process.exit(2);
}

const stubBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-smoke-agy-"));
// Minimal executable that satisfies resolveAgyExecutable / PATH lookups.
// initialize must not network-download a real agy CLI during smoke.
if (process.platform === "win32") {
  // Windows resolves `agy` via PATHEXT (.COM/.EXE/.BAT/.CMD). A tiny .cmd is enough.
  fs.writeFileSync(path.join(stubBinDir, "agy.cmd"), "@echo off\r\nexit /b 0\r\n");
} else {
  const stubAgyPath = path.join(stubBinDir, "agy");
  fs.writeFileSync(stubAgyPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

const childEnv = {
  ...process.env,
  PATH: `${stubBinDir}${path.delimiter}${process.env.PATH ?? ""}`
};

const child = spawn(process.execPath, [cliPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: childEnv
});

const timeoutMs = 30_000;
const timeout = delay(timeoutMs).then(() => {
  throw new Error(`timed out waiting for initialize response after ${timeoutMs}ms`);
});

async function run() {
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout)
  );
  const connection = acpClient({ name: "smoke-test" }).connect(stream);
  try {
    const response = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {}
    });
    if (response.agentInfo?.name !== "agy-acp") {
      throw new Error(`unexpected agentInfo.name: ${response.agentInfo?.name}`);
    }
    if (response.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`unexpected protocolVersion: ${response.protocolVersion}`);
    }
  } finally {
    connection.close();
  }
}

try {
  await Promise.race([run(), timeout]);
  console.log(`smoke-install: ok (${process.platform}/${process.arch}, node ${process.version})`);
  process.exitCode = 0;
} catch (err) {
  console.error(`smoke-install: FAILED (${process.platform}/${process.arch}, node ${process.version})`);
  console.error(err);
  process.exitCode = 1;
} finally {
  child.kill();
  try {
    fs.rmSync(stubBinDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}
