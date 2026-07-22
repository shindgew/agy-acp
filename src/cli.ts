import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import * as os from "node:os";
import path from "node:path";
import { conversationSnapshot } from "./db/scan.js";
import { defaultInstallBinDir, ensureAgyInstalled } from "./installer.js";
import { StreamPoller } from "./db/streaming.js";
export const DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS = 15_000;
export const DEFAULT_CONVERSATIONS_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations");
const POLL_INTERVAL_MS = 200;
/** Trailing polls after the process exits, to catch rows flushed right around exit. */
const TRAILING_POLL_ATTEMPTS = 3;
const TRAILING_POLL_DELAY_MS = 100;

export type SpawnedProcess = ChildProcessWithoutNullStreams;

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export type SpawnFactory = (
  command: string,
  args: string[],
  options: SpawnOptions
) => SpawnedProcess;

export interface AgyCliConfig {
  cwd: string;
  workspaces: string[];
  agyPath: string;
  /** Value for `--model` (base model slug or display name). */
  model?: string;
  /** Value for `--effort` (`low` | `medium` | `high`), when applicable. */
  effort?: string;
  fastMode: boolean;
  project?: string;
  printTimeout: string;
  sandbox: boolean;
  skipPermissions: boolean;
  logFile?: string;
  promptInArgv: boolean;
  autoInstall: boolean;
  installBinDir?: string;
  modelList: string[];
  discoverModels: boolean;
  modelListTimeoutMs: number;
  /** Directory where agy writes its per-conversation SQLite databases. */
  conversationsDir: string;
  env?: NodeJS.ProcessEnv;
}

export interface AgyPromptOutcome {
  stopReason: "end_turn" | "cancelled";
}

export interface AgyCliConfigInput {
  cwd: string;
  workspaces?: string[];
  env?: NodeJS.ProcessEnv;
  argv?: string[];
}

export class AgyCliError extends Error {
  readonly command: string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    message: string,
    command: string[],
    exitCode: number | null,
    stderr: string
  ) {
    super(message);
    this.name = "AgyCliError";
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class AgyCliSession {
  #process: SpawnedProcess | undefined;
  #cancelled = false;
  #extraPath: string | undefined;
  #conversationId: string | null = null;
  #lastStepIdx = -1;
  readonly config: AgyCliConfig;
  readonly spawnProcess: SpawnFactory;

  constructor(
    config: AgyCliConfig,
    spawnProcess: SpawnFactory = defaultSpawnFactory
  ) {
    this.config = config;
    this.spawnProcess = spawnProcess;
  }

  get wasCancelled(): boolean {
    return this.#cancelled;
  }

  /** The agy conversation id this session is bound to, once known (after the first prompt). */
  get conversationId(): string | null {
    return this.#conversationId;
  }

  /** Highest conversation-database step idx already delivered to the ACP client. */
  get lastStepIdx(): number {
    return this.#lastStepIdx;
  }

  /** Seed the conversation binding from persisted state (for session/load and session/resume). */
  restoreConversation(conversationId: string | null, lastStepIdx: number): void {
    this.#conversationId = conversationId;
    this.#lastStepIdx = lastStepIdx;
  }

  setModel(model: string | undefined): void {
    this.config.model = model;
  }

  setEffort(effort: string | undefined): void {
    this.config.effort = effort;
  }

  setFastMode(enabled: boolean): void {
    this.config.fastMode = enabled;
  }

  commandForPrompt(prompt: string): string[] {
    const effectivePrompt = this.effectivePrompt(prompt);
    const command = [
      this.config.agyPath,
      "--print"
    ];

    if (this.config.promptInArgv) {
      command.push(effectivePrompt);
    }

    command.push("--print-timeout", this.config.printTimeout);

    if (this.config.sandbox) {
      command.push("--sandbox");
    }
    if (this.config.skipPermissions) {
      command.push("--dangerously-skip-permissions");
    }
    if (this.config.model) {
      command.push("--model", this.config.model);
    }
    if (this.config.effort) {
      command.push("--effort", this.config.effort);
    }
    if (this.config.project) {
      command.push("--project", this.config.project);
    }
    if (this.config.logFile) {
      command.push("--log-file", this.config.logFile);
    }
    if (this.#conversationId) {
      command.push("--conversation", this.#conversationId);
    }

    const seen = new Set<string>();
    for (const workspace of this.config.workspaces) {
      const resolved = path.resolve(workspace);
      if (seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
      command.push("--add-dir", resolved);
    }

    return command;
  }

  /**
   * Run one prompt turn: spawn agy, poll its conversation database for newly
   * appended steps while the process runs, and invoke `onUpdate` with the
   * translated ACP updates in order. Resolves once the process exits and a few
   * trailing polls have drained any steps flushed right around exit.
   */
  async prompt(prompt: string, onUpdate: (update: SessionUpdate) => Promise<void>): Promise<AgyPromptOutcome> {
    const effectivePrompt = this.effectivePrompt(prompt);
    const command = this.commandForPrompt(prompt);
    try {
      return await this.runPromptCommand(command, effectivePrompt, onUpdate);
    } catch (error) {
      if (this.shouldInstallAfterError(error)) {
        await this.installAgy();
        return await this.runPromptCommand(this.commandForPrompt(prompt), effectivePrompt, onUpdate);
      }
      throw error;
    }
  }

  private effectivePrompt(prompt: string): string {
    return this.config.fastMode ? `/fast\n${prompt}` : prompt;
  }

  private async runPromptCommand(
    command: string[],
    prompt: string,
    onUpdate: (update: SessionUpdate) => Promise<void>
  ): Promise<AgyPromptOutcome> {
    const [program, ...args] = command;
    this.#cancelled = false;

    // Snapshot existing conversation ids *before* spawning, so the file agy
    // creates for a fresh prompt is guaranteed to look "new" once it appears —
    // spawning after the snapshot would risk racing agy's own DB creation.
    const snapshot = this.#conversationId === null ? conversationSnapshot(this.config.conversationsDir) : null;

    let child: SpawnedProcess;
    try {
      child = this.spawnProcess(program, args, this.spawnOptions());
    } catch (error) {
      throw this.errorForSpawnFailure(command, error as NodeJS.ErrnoException);
    }
    this.#process = child;
    const exitPromise = waitForExit(child);
    const errorPromise = once(child, "error") as Promise<[NodeJS.ErrnoException]>;
    const stderrChunks: Buffer[] = [];

    // agy persists its output to its own conversation database; stdout carries
    // nothing we read, but it must still be drained so the child can't block on
    // a full pipe.
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    const poller = new StreamPoller({
      dir: this.config.conversationsDir,
      conversationId: this.#conversationId,
      baseStepIdx: this.#lastStepIdx,
      skipNarration: false,
      cwd: this.config.cwd,
      snapshot
    });

    try {
      child.stdin.end(this.config.promptInArgv ? undefined : prompt);

      const pollOnce = async () => {
        for (const update of poller.poll()) {
          await onUpdate(update);
        }
      };

      let polling = true;
      const pollLoop = (async () => {
        while (polling) {
          await pollOnce();
          if (!polling) break;
          await sleep(POLL_INTERVAL_MS);
        }
      })();
      // pollLoop runs unawaited while we wait on the child process below; if it
      // rejects in that window Node would otherwise treat it as an unhandled
      // rejection and crash the whole server. Attaching a no-op handler here
      // marks it handled — the real rejection still surfaces from the `await
      // pollLoop` a few lines down, inside this try/catch.
      pollLoop.catch(() => {});

      const [exitCode] = child.exitCode === null
        ? await this.raceProcessError(exitPromise, errorPromise, command)
        : [child.exitCode, null];
      polling = false;
      await pollLoop;

      for (let attempt = 0; attempt < TRAILING_POLL_ATTEMPTS; attempt++) {
        await pollOnce();
        if (attempt < TRAILING_POLL_ATTEMPTS - 1) await sleep(TRAILING_POLL_DELAY_MS);
      }

      this.#conversationId = poller.conversationId;
      this.#lastStepIdx = poller.lastStepIdx;

      if (exitCode && !this.#cancelled) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        throw new AgyCliError(
          `agy exited with status ${exitCode}: ${stderr.trim() || "<no stderr>"}`,
          command,
          exitCode,
          stderr
        );
      }

      return { stopReason: this.#cancelled ? "cancelled" : "end_turn" };
    } finally {
      poller.close();
      if (this.#process === child) {
        this.#process = undefined;
      }
    }
  }

  private async raceProcessError<T>(
    promise: Promise<T>,
    errorPromise: Promise<[NodeJS.ErrnoException]>,
    command: string[]
  ): Promise<T> {
    return Promise.race([
      promise,
      errorPromise.then(([error]) => {
        throw this.errorForSpawnFailure(command, error);
      })
    ]);
  }

  private shouldInstallAfterError(error: unknown): boolean {
    return this.config.autoInstall &&
      this.config.agyPath === "agy" &&
      error instanceof AgyCliError &&
      error.exitCode === null &&
      isMissingExecutableError(error);
  }

  private async installAgy(): Promise<void> {
    const installed = await ensureAgyInstalled({
      env: this.config.env,
      installBinDir: this.config.installBinDir,
      warn: (message) => console.error(message)
    });
    if (!installed) {
      throw new AgyCliError(
        "agy executable not found and auto-install failed. Install the Google Antigravity CLI " +
          "or add its directory to PATH.",
        [this.config.agyPath],
        null,
        ""
      );
    }
  }

  private spawnOptions(): SpawnOptions {
    const env = this.spawnEnv();
    return env ? { cwd: this.config.cwd, env } : { cwd: this.config.cwd };
  }

  private spawnEnv(): NodeJS.ProcessEnv | undefined {
    const baseEnv = this.config.env;
    if (!this.#extraPath) {
      return baseEnv;
    }
    const source = baseEnv ?? process.env;
    const currentPath = source.PATH ?? "";
    const nextPath = currentPath
      ? `${this.#extraPath}${path.delimiter}${currentPath}`
      : this.#extraPath;
    return { ...source, PATH: nextPath };
  }

  private errorForSpawnFailure(command: string[], error: NodeJS.ErrnoException): AgyCliError {
    const executable = command[0];
    if (error.code === "ENOENT") {
      const hint = executable === this.config.agyPath && executable === "agy"
        ? "Install the Google Antigravity CLI or add its directory to PATH."
        : `Check the configured executable path: ${executable}.`;
      return new AgyCliError(`${executable} executable not found. ${hint}`, command, null, error.message);
    }
    return new AgyCliError(`${executable} failed to start: ${error.message}`, command, null, error.message);
  }

  async cancel(): Promise<void> {
    const child = this.#process;
    if (!child || child.exitCode !== null) {
      return;
    }
    this.#cancelled = true;
    const exitPromise = once(child, "exit");
    // SIGINT (rather than SIGTERM) gives agy a chance to flush its last
    // conversation-database write before exiting. Windows has no real SIGINT,
    // so fall back to an ungraceful kill there.
    if (process.platform === "win32") {
      child.kill();
    } else {
      child.kill("SIGINT");
    }
    const timeout = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 5000);
    try {
      if (child.exitCode === null) {
        await exitPromise;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async close(): Promise<void> {
    await this.cancel();
  }
}

export class AgyCliBackend {
  readonly spawnProcess: SpawnFactory;

  constructor(spawnProcess: SpawnFactory = defaultSpawnFactory) {
    this.spawnProcess = spawnProcess;
  }

  async startSession(config: AgyCliConfig): Promise<AgyCliSession> {
    return new AgyCliSession(config, this.spawnProcess);
  }

  async listModels(config: AgyCliConfig): Promise<string[]> {
    const command = [config.agyPath, "models"];
    let child: SpawnedProcess;
    try {
      child = this.spawnProcess(command[0], command.slice(1), { cwd: config.cwd, env: config.env });
    } catch (error) {
      throw errorForSpawnFailure(command, error as NodeJS.ErrnoException);
    }
    child.stdin.end();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const exitPromise = waitForExit(child);
    const stdoutDone = once(child.stdout, "end").catch(() => undefined);
    const stderrDone = once(child.stderr, "end").catch(() => undefined);
    const errorPromise = once(child, "error") as Promise<[NodeJS.ErrnoException]>;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 5000).unref();
    }, config.modelListTimeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    try {
      const [exitCode] = child.exitCode === null
        ? await raceProcessError(exitPromise, errorPromise, command)
        : [child.exitCode, null];
      if (timedOut) {
        throw new AgyCliError("agy models timed out", command, null, "");
      }
      if (exitCode) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        throw new AgyCliError(
          `agy models exited with status ${exitCode}: ${stderr.trim() || "<no stderr>"}`,
          command,
          exitCode,
          stderr
        );
      }
      await Promise.allSettled([stdoutDone, stderrDone]);
    } finally {
      clearTimeout(timeout);
    }

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    return parseAgyModels(stdout);
  }
}

export function configFromEnv(input: AgyCliConfigInput): AgyCliConfig {
  const env = input.env ?? process.env;
  const argv = input.argv ?? [];

  let sandbox = true;
  if (env.AGY_ACP_SANDBOX === "false" || env.AGY_ACP_NO_SANDBOX) {
    sandbox = false;
  }
  if (argv.includes("--no-sandbox")) {
    sandbox = false;
  }
  if (argv.includes("--sandbox")) {
    sandbox = true;
  }

  let skipPermissions = false;
  if (env.AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS || argv.includes("--dangerously-skip-permissions")) {
    skipPermissions = true;
  }

  return {
    cwd: input.cwd,
    workspaces: input.workspaces ?? [input.cwd],
    agyPath: "agy",
    model: undefined,
    effort: undefined,
    fastMode: false,
    project: undefined,
    printTimeout: "5m0s",
    sandbox,
    skipPermissions,
    logFile: undefined,
    promptInArgv: true,
    autoInstall: false,
    installBinDir: defaultInstallBinDir(env),
    modelList: [],
    discoverModels: true,
    modelListTimeoutMs: DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS,
    conversationsDir: optional(env.AGY_ACP_CONVERSATIONS_DIR) ?? DEFAULT_CONVERSATIONS_DIR,
    env
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawnFactory(command: string, args: string[], options: SpawnOptions): SpawnedProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseAgyModels(output: string): string[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isAgyStatusLine(line));
  return dedupe(lines);
}

function isAgyStatusLine(line: string): boolean {
  return line === "Fetching available models..." ||
    /^[IWEF]\d{4}\s/.test(line) ||
    line.includes("You are not logged into Antigravity") ||
    line.includes("Failed to") ||
    line.startsWith("error ");
}

function waitForExit(child: SpawnedProcess): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve([code, signal]));
  });
}

function raceProcessError<T>(
  promise: Promise<T>,
  errorPromise: Promise<[NodeJS.ErrnoException]>,
  command: string[]
): Promise<T> {
  return Promise.race([
    promise,
    errorPromise.then(([error]) => {
      throw errorForSpawnFailure(command, error);
    })
  ]);
}

function errorForSpawnFailure(command: string[], error: NodeJS.ErrnoException): AgyCliError {
  const executable = command[0];
  if (error.code === "ENOENT") {
    return new AgyCliError(`${executable} executable not found. Check the configured executable path: ${executable}.`, command, null, error.message);
  }
  return new AgyCliError(`${executable} failed to start: ${error.message}`, command, null, error.message);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function isMissingExecutableError(error: AgyCliError): boolean {
  return error.stderr.includes("ENOENT") || error.message.includes("executable not found");
}
