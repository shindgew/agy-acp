#!/usr/bin/env node
// Exercises a built `agy-acp` CLI exactly as a real ACP client would: spawn
// it, speak ND-JSON over its actual stdio, and complete `initialize`. This
// is the one check that forces Node to `require("better-sqlite3")` through
// the platform's real prebuilt (or compiled) native binary, which is the
// part that can silently break per OS/arch and unit tests never spawn a
// subprocess for.
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { client as acpClient, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const cliPath = process.argv[2];
if (!cliPath) {
  console.error("usage: smoke-install.mjs <path-to-cli.js>");
  process.exit(2);
}

const child = spawn(process.execPath, [cliPath], { stdio: ["pipe", "pipe", "inherit"] });

const timeout = delay(15_000).then(() => {
  throw new Error("timed out waiting for initialize response");
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
}
