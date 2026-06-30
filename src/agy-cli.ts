import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

export const DEFAULT_AGY_INSTALL_COMMAND = "curl -fsSL https://antigravity.google/cli/install.sh | bash";
export const DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS = 15_000;

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
  model?: string;
  fastMode: boolean;
  project?: string;
  printTimeout: string;
  sandbox: boolean;
  skipPermissions: boolean;
  logFile?: string;
  promptInArgv: boolean;
  autoInstall: boolean;
  installCommand: string;
  installBinDir?: string;
  modelList: string[];
  discoverModels: boolean;
  modelListTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface AgyCliConfigInput {
  cwd: string;
  workspaces?: string[];
  env?: NodeJS.ProcessEnv;
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

  setModel(model: string | undefined): void {
    this.config.model = model;
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
    if (this.config.project) {
      command.push("--project", this.config.project);
    }
    if (this.config.logFile) {
      command.push("--log-file", this.config.logFile);
    }

    const cwd = path.resolve(this.config.cwd);
    for (const workspace of this.config.workspaces) {
      const resolved = path.resolve(workspace);
      if (resolved !== cwd) {
        command.push("--add-dir", resolved);
      }
    }

    return command;
  }

  async *prompt(prompt: string): AsyncGenerator<string> {
    const effectivePrompt = this.effectivePrompt(prompt);
    const command = this.commandForPrompt(prompt);
    try {
      yield* this.runPromptCommand(command, effectivePrompt);
    } catch (error) {
      if (this.shouldInstallAfterError(error)) {
        await this.installAgy();
        yield* this.runPromptCommand(this.commandForPrompt(prompt), effectivePrompt);
        return;
      }
      throw error;
    }
  }

  private effectivePrompt(prompt: string): string {
    return this.config.fastMode ? `/fast\n${prompt}` : prompt;
  }

  private async *runPromptCommand(command: string[], prompt: string): AsyncGenerator<string> {
    const [program, ...args] = command;
    this.#cancelled = false;
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

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    try {
      child.stdin.end(this.config.promptInArgv ? undefined : prompt);

      for await (const chunk of child.stdout) {
        yield Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      }

      const [exitCode] = child.exitCode === null
        ? await this.raceProcessError(exitPromise, errorPromise, command)
        : [child.exitCode, null];
      if (exitCode && !this.#cancelled) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        throw new AgyCliError(
          `agy exited with status ${exitCode}: ${stderr.trim() || "<no stderr>"}`,
          command,
          exitCode,
          stderr
        );
      }
    } finally {
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
    const command = ["sh", "-c", this.config.installCommand];
    let child: SpawnedProcess;
    try {
      child = this.spawnProcess(command[0], command.slice(1), this.spawnOptions());
    } catch (error) {
      throw this.errorForSpawnFailure(command, error as NodeJS.ErrnoException);
    }
    const exitPromise = waitForExit(child);
    const errorPromise = once(child, "error") as Promise<[NodeJS.ErrnoException]>;
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", () => {
      // Drain installer stdout so the subprocess cannot block on a full pipe.
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    const [exitCode] = child.exitCode === null
      ? await this.raceProcessError(exitPromise, errorPromise, command)
      : [child.exitCode, null];
    if (exitCode) {
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      throw new AgyCliError(
        `agy installer exited with status ${exitCode}: ${stderr.trim() || "<no stderr>"}`,
        command,
        exitCode,
        stderr
      );
    }
    this.#extraPath = this.config.installBinDir;
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
        ? "Install the Google Antigravity CLI or set AGY_ACP_AGY_PATH to the agy executable."
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
    child.kill("SIGTERM");
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
  return {
    cwd: input.cwd,
    workspaces: input.workspaces ?? [input.cwd],
    agyPath: optional(env.AGY_ACP_AGY_PATH) ?? "agy",
    model: undefined,
    fastMode: false,
    project: undefined,
    printTimeout: "5m0s",
    sandbox: true,
    skipPermissions: false,
    logFile: undefined,
    promptInArgv: true,
    autoInstall: false,
    installCommand: DEFAULT_AGY_INSTALL_COMMAND,
    installBinDir: defaultInstallBinDir(env),
    modelList: [],
    discoverModels: true,
    modelListTimeoutMs: DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS,
    env
  };
}

function defaultSpawnFactory(command: string, args: string[], options: SpawnOptions): SpawnedProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function defaultInstallBinDir(env: NodeJS.ProcessEnv): string | undefined {
  const home = optional(env.HOME);
  return home ? path.join(home, ".local", "bin") : undefined;
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
