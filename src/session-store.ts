// Persists ACP session bindings (which agy conversation a session is bound to,
// and the caller's last config choices) across server restarts, so
// `session/load`, `session/resume`, and `session/list` can reconstruct a
// session after the ACP client reconnects.
//
// Writes are serialized through an in-process promise chain (so concurrent
// persists can't clobber each other) and committed atomically via temp-file +
// rename.
//
// Stored under its own directory (not the sibling `antigravity-acp` project's
// `~/.agy-acp`) so the two tools can't collide if both happen to be installed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where session bindings live, given a process environment. Exposed as a
 *  function (rather than a module-level constant) so callers — including
 *  tests — control it via the same `env` they already thread through
 *  `configFromEnv`, instead of it being fixed at module-load time. */
export function defaultStateDir(env: NodeJS.ProcessEnv): string {
  return optional(env.AGY_ACP_STATE_DIR) ?? path.join(os.homedir(), ".agy-acp-state");
}

export interface StoredSession {
  cwd: string;
  workspaces: string[];
  conversationId: string | null;
  lastStepIdx: number;
  modelId: string;
  reasoningEffect: string;
  fastMode: boolean;
  updatedAt: string;
}

interface DiskStore {
  sessions: Record<string, StoredSession>;
}

export class SessionStore {
  #writeChain: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = path.join(dir, "sessions.json");
  }

  /** Restore a persisted session binding, or null if none exists. */
  async restore(sessionId: string): Promise<StoredSession | null> {
    const store = await this.load();
    return store.sessions[sessionId] ?? null;
  }

  /**
   * List persisted session bindings, newest first.
   * Optional `cwd` filters to sessions whose stored working directory matches.
   */
  async list(filter?: { cwd?: string | null }): Promise<Array<{ sessionId: string } & StoredSession>> {
    const store = await this.load();
    const cwd = filter?.cwd ?? null;
    return Object.entries(store.sessions)
      .filter(([, session]) => cwd == null || session.cwd === cwd)
      .map(([sessionId, session]) => ({ sessionId, ...session }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Persist a session binding. Resolves once written (writes are serialized). */
  persist(sessionId: string, session: StoredSession): Promise<void> {
    this.#writeChain = this.#writeChain.then(() => this.writeOne(sessionId, session)).catch((error) => {
      console.error(`[agy-acp] WARN: failed to persist session: ${(error as Error).message}`);
    });
    return this.#writeChain;
  }

  private async load(): Promise<DiskStore> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.file, "utf-8")) as {
        sessions?: Record<string, StoredSession>;
      };
      return { sessions: parsed.sessions ?? {} };
    } catch {
      return { sessions: {} };
    }
  }

  private async writeOne(sessionId: string, session: StoredSession): Promise<void> {
    const store = await this.load();
    store.sessions[sessionId] = session;
    await fs.promises.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(store, null, 2));
    await fs.promises.rename(tmp, this.file);
  }
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
