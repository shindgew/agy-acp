import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, statSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conversationSnapshot } from "./db/scan.js";
import { defaultInstallBinDir, ensureAgyInstalled } from "./installer.js";
import { StreamPoller } from "./db/streaming.js";
import {
  canBridgeInteraction,
  interactionKeys,
  parseAskQuestion,
  type AgyPermissionChoice
} from "./permissions.js";
export const DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS = 15_000;
export const DEFAULT_CONVERSATIONS_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations");
const POLL_INTERVAL_MS = 200;
/** Trailing polls after the process exits, to catch rows flushed right around exit. */
const TRAILING_POLL_ATTEMPTS = 3;
const TRAILING_POLL_DELAY_MS = 100;

export type SpawnedProcess = ChildProcessWithoutNullStreams;

export interface PtyProcess {
  write(data: string): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}
export interface PtyFactory {
  spawn(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; cols: number; rows: number }): PtyProcess;
}
export type PermissionCallback = (
  toolCall: SessionUpdate,
  context: { toolName: string }
) => Promise<AgyPermissionChoice | "cancelled">;

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export type SpawnFactory = (
  command: string,
  args: string[],
  options: SpawnOptions
) => SpawnedProcess;

/** agy execution mode for `--mode` (omit flag when `default`). */
export type AgyExecutionMode = "default" | "accept-edits" | "plan";

export const AGY_EXECUTION_MODES: readonly AgyExecutionMode[] = [
  "default",
  "accept-edits",
  "plan"
] as const;

export function isAgyExecutionMode(value: string): value is AgyExecutionMode {
  return (AGY_EXECUTION_MODES as readonly string[]).includes(value);
}

export interface AgyCliConfig {
  cwd: string;
  workspaces: string[];
  agyPath: string;
  /** Value for `--model` (base model slug or display name). */
  model?: string;
  /** Value for `--effort` (`low` | `medium` | `high`), when applicable. */
  effort?: string;
  /**
   * Agent execution mode for `agy --mode`.
   * `default` omits the flag (request-review / write confirmation).
   * `accept-edits` and `plan` pass `--mode <value>`.
   */
  mode: AgyExecutionMode;
  project?: string;
  printTimeout: string;
  sandbox: boolean;
  skipPermissions: boolean;
  interactivePermissions: boolean;
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
  #pty: PtyProcess | undefined;
  #ptyExit: Promise<{ exitCode: number }> | undefined;
  #ptyOutput = "";
  #ptyIdleMarkerCount = 0;
  #ptyIdleMatchTail = "";
  #ptyConfig = "";
  #cancelled = false;
  #cancelTurn: (() => void) | undefined;
  #cancelWait: Promise<void> = Promise.resolve();
  #extraPath: string | undefined;
  #conversationId: string | null = null;
  #lastStepIdx = -1;
  readonly config: AgyCliConfig;
  readonly spawnProcess: SpawnFactory;
  readonly ptyFactory?: PtyFactory;

  constructor(
    config: AgyCliConfig,
    spawnProcess: SpawnFactory = defaultSpawnFactory,
    ptyFactory?: PtyFactory
  ) {
    this.config = config;
    this.spawnProcess = spawnProcess;
    this.ptyFactory = ptyFactory;
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

  setMode(mode: AgyExecutionMode): void {
    this.config.mode = mode;
  }

  commandForPrompt(prompt: string): string[] {
    const command = [
      this.config.agyPath,
      "--print"
    ];

    if (this.config.promptInArgv) {
      command.push(prompt);
    }

    command.push("--print-timeout", this.config.printTimeout);

    if (this.config.sandbox) {
      command.push("--sandbox");
    }
    if (this.config.skipPermissions) {
      command.push("--dangerously-skip-permissions");
    }
    if (this.config.mode !== "default") {
      command.push("--mode", this.config.mode);
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

  interactiveCommandForPrompt(prompt: string): string[] {
    const command = this.commandForPrompt(prompt);
    const timeout = command.indexOf("--print-timeout");
    if (timeout >= 0) command.splice(timeout, 2);
    const print = command.indexOf("--print");
    if (print >= 0) command.splice(print, this.config.promptInArgv ? 2 : 1);
    command.splice(1, 0, "--prompt-interactive", prompt);
    return command;
  }

  /**
   * Run one prompt turn: spawn agy, poll its conversation database for newly
   * appended steps while the process runs, and invoke `onUpdate` with the
   * translated ACP updates in order. Resolves once the process exits and a few
   * trailing polls have drained any steps flushed right around exit.
   */
  async prompt(prompt: string, onUpdate: (update: SessionUpdate) => Promise<void>, onPermission?: PermissionCallback): Promise<AgyPromptOutcome> {
    if (this.config.interactivePermissions) {
      if (!onPermission) throw new Error("interactive permissions require a permission callback");
      return this.runInteractivePrompt(prompt, onUpdate, onPermission);
    }
    const command = this.commandForPrompt(prompt);
    try {
      return await this.runPromptCommand(command, prompt, onUpdate);
    } catch (error) {
      if (this.shouldInstallAfterError(error)) {
        await this.installAgy();
        return await this.runPromptCommand(this.commandForPrompt(prompt), prompt, onUpdate);
      }
      throw error;
    }
  }

  private async runInteractivePrompt(prompt: string, onUpdate: (update: SessionUpdate) => Promise<void>, onPermission: PermissionCallback): Promise<AgyPromptOutcome> {
    this.#cancelled = false;
    this.#cancelWait = new Promise((resolve) => { this.#cancelTurn = resolve; });
    const signature = JSON.stringify([this.config.model, this.config.effort, this.config.mode]);
    if (this.#pty && this.#ptyConfig !== signature) await this.stopPty();
    if (this.#cancelled) { this.#cancelTurn = undefined; return { stopReason: "cancelled" }; }
    const snapshot = this.#conversationId === null ? conversationSnapshot(this.config.conversationsDir) : null;
    let freshPty = false;
    if (!this.#pty) {
      const factory = this.ptyFactory ?? await defaultPtyFactory();
      if (this.#cancelled) { this.#cancelTurn = undefined; return { stopReason: "cancelled" }; }
      const [program, ...args] = this.interactiveCommandForPrompt(prompt);
      this.#pty = factory.spawn(program, args, { ...this.spawnOptions(), cols: 120, rows: 40 });
      freshPty = true;
      this.#ptyConfig = signature;
      this.#ptyOutput = "";
      this.#ptyIdleMarkerCount = 0;
      this.#ptyIdleMatchTail = "";
      this.#pty.onData((data) => {
        const marker = "for shortcuts";
        const searchable = this.#ptyIdleMatchTail + data;
        let offset = 0;
        while ((offset = searchable.indexOf(marker, offset)) >= 0) {
          this.#ptyIdleMarkerCount++;
          offset += marker.length;
        }
        this.#ptyIdleMatchTail = searchable.slice(-(marker.length - 1));
        this.#ptyOutput = (this.#ptyOutput + data).slice(-16_384);
      });
      this.#ptyExit = new Promise((resolve) => this.#pty!.onExit(resolve));
    } else {
      this.#pty.write(`\x1b[200~${prompt.replaceAll("\x1b", "")}\x1b[201~\r`);
    }
    const poller = new StreamPoller({ dir: this.config.conversationsDir, conversationId: this.#conversationId,
      baseStepIdx: this.#lastStepIdx, skipNarration: false, cwd: this.config.cwd, snapshot });
    const requested = new Set<string>();
    const activePtyExit = this.#ptyExit!;
    const deadline = Date.now() + parsePrintTimeoutMs(this.config.printTimeout);
    let candidateRevision = -1;
    let seenRevision = -1;
    // A newly spawned TUI first draws its initial idle prompt, then draws
    // another when the submitted turn finishes. A reused TUI only owes the
    // latter marker.
    let requiredIdleMarkerCount = this.#ptyIdleMarkerCount + (freshPty ? 2 : 1);
    let failed = false;
    try {
      while (true) {
        if (this.#cancelled) break;
        if (Date.now() >= deadline) throw new AgyCliError(`agy interactive turn timed out after ${this.config.printTimeout}; no final idle marker was observed`, [this.config.agyPath], null, this.#ptyOutput);
        const updates = poller.poll();
        if (poller.revision !== seenRevision) {
          seenRevision = poller.revision;
          candidateRevision = poller.turnCompleteCandidate ? poller.revision : -1;
        } else if (!poller.turnCompleteCandidate) candidateRevision = -1;
        for (const update of updates) await this.raceTurnCallback(onUpdate(update), deadline);
        if (this.#cancelled) break;
        for (const interaction of poller.takePending()) {
          const toolCall = interaction.update;
          const id = String((toolCall as unknown as { toolCallId?: string }).toolCallId);
          if (requested.has(id)) continue;
          requested.add(id);
          if (!canBridgeInteraction(interaction.toolName, toolCall)) {
            const detail = unsupportedInteractionDetail(interaction.toolName, toolCall);
            throw new AgyCliError(
              `Unsupported agy interaction '${interaction.toolName}' (status 9); ${detail}`,
              [this.config.agyPath],
              null,
              this.#ptyOutput
            );
          }
          const choice = await this.raceTurnCallback(
            onPermission(toolCall, { toolName: interaction.toolName }),
            deadline
          );
          if (this.#cancelled || choice === "cancelled") { this.#cancelled = true; break; }
          const keys = interactionKeys(choice, interaction.toolName, toolCall);
          if (keys == null) {
            throw new AgyCliError(
              `Unsupported permission choice '${choice}' for '${interaction.toolName}'`,
              [this.config.agyPath],
              null,
              this.#ptyOutput
            );
          }
          this.#pty?.write(keys);
          // An idle marker printed before the decision cannot mean that the
          // approved/rejected command has finished.
          requiredIdleMarkerCount = this.#ptyIdleMarkerCount + 1;
        }
        if (this.#cancelled) break;
        if (candidateRevision === poller.revision && this.#ptyIdleMarkerCount >= requiredIdleMarkerCount) break;
        const exited = await Promise.race([activePtyExit.then(() => true), sleep(POLL_INTERVAL_MS).then(() => false)]);
        if (exited && !this.#cancelled) throw new AgyCliError(`agy interactive PTY exited unexpectedly: ${this.#ptyOutput.trim() || "<no output>"}`, [this.config.agyPath], null, this.#ptyOutput);
      }
      return { stopReason: this.#cancelled ? "cancelled" : "end_turn" };
    } catch (error) {
      failed = true;
      await this.stopPty();
      throw error;
    } finally {
      this.#conversationId = poller.conversationId ?? this.#conversationId;
      this.#lastStepIdx = Math.max(this.#lastStepIdx, poller.lastStepIdx);
      poller.close();
      if (this.#cancelled && !failed) await this.stopPty();
      this.#cancelTurn = undefined;
    }
  }

  private async raceTurnCallback<T>(callback: Promise<T>, deadline: number): Promise<T | "cancelled"> {
    const guarded = callback.catch((error) => {
      if (this.#cancelled) return "cancelled" as const;
      throw error;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AgyCliError(`agy interactive turn timed out after ${this.config.printTimeout}; no final idle marker was observed`, [this.config.agyPath], null, this.#ptyOutput)), Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([guarded, this.#cancelWait.then(() => "cancelled" as const), timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
    if (this.#cancelTurn) {
      this.#cancelled = true;
      this.#cancelTurn();
      if (this.#pty) await this.stopPty();
      return;
    }
    if (this.#pty) {
      this.#cancelled = true;
      await this.stopPty();
      return;
    }
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

  private async stopPty(): Promise<void> {
    const pty = this.#pty;
    const exit = this.#ptyExit;
    this.#pty = undefined;
    this.#ptyExit = undefined;
    if (pty) {
      try { pty.kill(); } catch {}
      if (exit) {
        const exited = await Promise.race([exit.then(() => true), sleep(2_000).then(() => false)]);
        if (!exited) {
          try { pty.kill("SIGKILL"); } catch {}
          await Promise.race([exit, sleep(500)]);
        }
      }
    }
  }

  async close(): Promise<void> {
    await this.cancel();
  }
}

export class AgyCliBackend {
  readonly spawnProcess: SpawnFactory;

  readonly ptyFactory?: PtyFactory;
  constructor(spawnProcess: SpawnFactory = defaultSpawnFactory, ptyFactory?: PtyFactory) {
    this.spawnProcess = spawnProcess;
    this.ptyFactory = ptyFactory;
  }

  async startSession(config: AgyCliConfig): Promise<AgyCliSession> {
    return new AgyCliSession(config, this.spawnProcess, this.ptyFactory);
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
  // Interactive permission forwarding is the normal execution path. The
  // explicit dangerous bypass selects print mode because there is no
  // permission request to forward when agy auto-approves everything.
  const interactiveSetting = env.AGY_ACP_INTERACTIVE_PERMISSIONS?.trim().toLowerCase();
  const interactiveDisabled = interactiveSetting === "0" || interactiveSetting === "false" || argv.includes("--no-interactive-permissions");
  const interactivePermissions = !skipPermissions && !interactiveDisabled;

  let mode: AgyExecutionMode = "default";
  const modeFromEnv = optional(env.AGY_ACP_MODE);
  if (modeFromEnv && isAgyExecutionMode(modeFromEnv)) {
    mode = modeFromEnv;
  }
  const modeFlagIdx = argv.indexOf("--mode");
  if (modeFlagIdx >= 0) {
    const modeArg = argv[modeFlagIdx + 1];
    if (modeArg && isAgyExecutionMode(modeArg)) {
      mode = modeArg;
    }
  }

  return {
    cwd: input.cwd,
    workspaces: input.workspaces ?? [input.cwd],
    agyPath: "agy",
    model: undefined,
    effort: undefined,
    mode,
    project: undefined,
    printTimeout: "5m0s",
    sandbox,
    skipPermissions,
    interactivePermissions,
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

export async function defaultPtyFactory(): Promise<PtyFactory> {
  if (process.platform !== "win32") {
    const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("node-pty"))));
    const nativeDirs = [
      path.join(packageRoot, "build", "Release"),
      path.join(packageRoot, "build", "Debug"),
      path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`)
    ];
    const nativeDir = nativeDirs.find((dir) => existsSync(path.join(dir, "pty.node")));
    const helper = nativeDir && path.join(nativeDir, "spawn-helper");
    const helperMode = helper && existsSync(helper) ? statSync(helper).mode : undefined;
    if (helper && helperMode !== undefined && (helperMode & 0o111) === 0) {
      // node-pty 1.1.0's npm tarball loses this executable bit on some npm
      // clients. Its native addon invokes the helper directly, so repair the
      // packaged mode before the first spawn.
      try {
        chmodSync(helper, helperMode | 0o111);
      } catch (error) {
        throw new Error(`node-pty spawn-helper is not executable and could not be repaired at ${helper}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const pty = await import("node-pty");
  return { spawn: (command, args, options) => pty.spawn(command, args, { ...options, name: "xterm-256color" }) };
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Parse Go duration forms used by agy (for example 5m0s and 30s). */
function parsePrintTimeoutMs(value: string): number {
  const source = value.trim();
  let total = 0;
  let consumed = "";
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    consumed += match[0];
    const scale = match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
    total += Number(match[1]) * scale;
  }
  return consumed === source && total > 0 ? total : 5 * 60_000;
}

export function parseAgyModels(output: string): string[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isAgyStatusLine(line));
  return dedupe(lines);
}

function unsupportedInteractionDetail(toolName: string, toolCall: SessionUpdate): string {
  if (toolName === "ask_question") {
    const ask = parseAskQuestion(toolCall);
    if (!ask) return "ask_question payload could not be parsed";
    if (ask.questionCount !== 1) return "only single-question ask_question menus can be bridged safely";
    if (ask.multiSelect) return "multi-select ask_question is not bridged yet";
    if (ask.options.length === 0) return "ask_question has no selectable options";
    return "ask_question could not be bridged";
  }
  return "only standard permission menus (run_command, file read/write) and single-select ask_question can be bridged safely";
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
