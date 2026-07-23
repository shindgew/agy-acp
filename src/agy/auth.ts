// Antigravity CLI authentication helpers for ACP authMethods / authenticate / logout.
//
// Login is interactive (Google AI Pro web code paste, or API key) inside the agy TUI.
// ACP terminal auth launches `agy-acp --login`, which runs interactive `agy` with
// inherited stdio so the user can complete that flow. Logout maps to TUI `/logout`
// via a short-lived PTY, then re-probes with `agy models`.

import { spawn } from "node:child_process";
import { once } from "node:events";
import type { AuthMethod as V1AuthMethod } from "@agentclientprotocol/sdk";
import type { AuthMethod as V2AuthMethod } from "@agentclientprotocol/sdk/experimental/v2";
import {
  AgyCliError,
  configFromEnv,
  defaultPtyFactory,
  type AgyCliBackend,
  type AgyCliConfig,
  type PtyFactory,
  type PtyProcess
} from "./cli.js";
import { ensureAgyInstalled } from "./installer.js";

/** ACP method id for interactive terminal login (client runs agent binary with --login). */
export const AUTH_METHOD_TERMINAL_LOGIN = "agy-login";

/** ACP method id for re-checking an existing keyring login (agent-side probe only). */
export const AUTH_METHOD_AGENT_STATUS = "agy-status";

const NOT_LOGGED_IN_RE = /not logged into antigravity|not logged in|authentication required|please log in|login required/i;
const IDLE_MARKER = "for shortcuts";
const LOGOUT_SETTLE_MS = 1_500;
const LOGOUT_IDLE_TIMEOUT_MS = 20_000;

export function v1AuthMethods(): V1AuthMethod[] {
  return [
    {
      type: "terminal",
      id: AUTH_METHOD_TERMINAL_LOGIN,
      name: "Google Antigravity (CLI)",
      description:
        "Opens a terminal to sign in with Google AI Pro (web auth + paste code) or an API key. " +
        "Complete the agy login prompts, then return to the editor.",
      args: ["--login"]
    },
    {
      id: AUTH_METHOD_AGENT_STATUS,
      name: "Use existing Antigravity login",
      description:
        "Succeeds if agy is already signed in on this machine (keyring). " +
        "If not, complete terminal login first."
    }
  ];
}

export function v2AuthMethods(): V2AuthMethod[] {
  return [
    {
      type: "terminal",
      methodId: AUTH_METHOD_TERMINAL_LOGIN,
      name: "Google Antigravity (CLI)",
      description:
        "Opens a terminal to sign in with Google AI Pro (web auth + paste code) or an API key. " +
        "Complete the agy login prompts, then return to the editor.",
      args: ["--login"]
    },
    {
      type: "agent",
      methodId: AUTH_METHOD_AGENT_STATUS,
      name: "Use existing Antigravity login",
      description:
        "Succeeds if agy is already signed in on this machine (keyring). " +
        "If not, complete terminal login first."
    }
  ];
}

export function isKnownAuthMethodId(methodId: string): boolean {
  return methodId === AUTH_METHOD_TERMINAL_LOGIN || methodId === AUTH_METHOD_AGENT_STATUS;
}

/**
 * True when `agy models` succeeds with at least one model.
 * Treats explicit "not logged in" errors as unauthenticated; other failures
 * also count as not ready for sessions (caller surfaces the message).
 */
export async function isAgyAuthenticated(
  backend: AgyCliBackend,
  config: AgyCliConfig
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const models = await backend.listModels(config);
    if (models.length === 0) {
      return { ok: false, reason: "agy models returned no models (sign in may be required)." };
    }
    return { ok: true };
  } catch (error) {
    const reason = formatAuthProbeError(error);
    return { ok: false, reason };
  }
}

export function formatAuthProbeError(error: unknown): string {
  if (error instanceof AgyCliError) {
    const detail = `${error.message}\n${error.stderr}`.trim();
    if (NOT_LOGGED_IN_RE.test(detail)) {
      return "You are not logged into Antigravity.";
    }
    return error.message;
  }
  if (error instanceof Error) {
    if (NOT_LOGGED_IN_RE.test(error.message)) {
      return "You are not logged into Antigravity.";
    }
    return error.message;
  }
  return String(error);
}

export function looksUnauthenticated(reason: string): boolean {
  return NOT_LOGGED_IN_RE.test(reason) || /sign in may be required/i.test(reason);
}

/**
 * Interactive login for `agy-acp --login` (terminal auth method).
 * Runs `agy` with inherited stdio so the user can complete API key or web+code flow.
 */
export async function runInteractiveAgyLogin(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  argv?: string[];
}): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  await ensureAgyInstalled({
    env,
    warn: (message) => console.error(message)
  });

  const config = configFromEnv({ cwd, env, argv: options.argv ?? [] });
  const child = spawn(config.agyPath, [], {
    cwd,
    env: config.env ?? env,
    stdio: "inherit"
  });

  const [code] = await once(child, "exit");
  return typeof code === "number" ? code : 1;
}

/**
 * Best-effort logout: start interactive agy, wait for idle UI, send `/logout`, stop.
 * Tokens are stored in the OS keyring by agy; we do not scrape files ourselves.
 */
export async function logoutAgyViaSlashCommand(options: {
  backend: AgyCliBackend;
  config: AgyCliConfig;
  ptyFactory?: PtyFactory;
}): Promise<void> {
  const factory = options.ptyFactory ?? options.backend.ptyFactory ?? (await defaultPtyFactory());
  const env = {
    ...(options.config.env ?? process.env),
    TERM: "xterm-256color"
  };

  let output = "";
  let idleCount = 0;
  let idleTail = "";
  let exited = false;

  const pty: PtyProcess = factory.spawn(options.config.agyPath, [], {
    cwd: options.config.cwd,
    env,
    cols: 120,
    rows: 40
  });

  const exitPromise = new Promise<{ exitCode: number }>((resolve) => {
    pty.onExit((event) => {
      exited = true;
      resolve({ exitCode: event.exitCode });
    });
  });

  pty.onData((chunk) => {
    output += chunk;
    if (output.length > 64_000) output = output.slice(-32_000);
    const combined = idleTail + chunk;
    const matches = combined.match(new RegExp(IDLE_MARKER, "g"));
    if (matches) idleCount += matches.length;
    idleTail = combined.length > IDLE_MARKER.length ? combined.slice(-IDLE_MARKER.length) : combined;
  });

  const deadline = Date.now() + LOGOUT_IDLE_TIMEOUT_MS;
  while (!exited && idleCount < 1 && Date.now() < deadline) {
    await sleep(50);
  }

  if (!exited) {
    // Bracketed paste is unnecessary for a single-line slash command.
    pty.write("/logout\r");
    await sleep(LOGOUT_SETTLE_MS);
  }

  if (!exited) {
    try {
      pty.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  await Promise.race([exitPromise, sleep(3_000)]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
