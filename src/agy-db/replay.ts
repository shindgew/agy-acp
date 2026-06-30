// Full conversation-history replay for session/load, with an incremental cache.
//
// agy conversation DBs are append-only, so replays are cached per conversation
// and validated by file (mtime, size). On a cache hit the result is returned
// without touching SQLite; when the file has merely grown, only the new tail of
// steps is read and translated, then appended to the cached updates.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { ConversationDb, type DbStat, statConversation } from "./database.js";
import { Lru } from "./lru.js";
import { Translator } from "./translator.js";

export interface ReplayOptions {
  skipNarration: boolean;
  cwd?: string;
}

export interface ReplayResult {
  updates: SessionUpdate[];
  /** Highest step idx covered (advances even for steps that emit nothing). */
  maxIdx: number;
}

interface CacheEntry extends ReplayResult {
  stat: DbStat;
  skipNarration: boolean;
  cwd: string | undefined;
}

/** Translate an entire conversation from scratch. Returns null if unreadable. */
function buildReplay(dir: string, id: string, opts: ReplayOptions): ReplayResult | null {
  const conn = ConversationDb.open(dir, id);
  if (!conn) return null;
  try {
    const translator = new Translator({ mode: "replay", ...opts });
    const updates = translator.translate(conn.readAfter(-1));
    return { updates, maxIdx: translator.lastStepIdx };
  } finally {
    conn.close();
  }
}

/**
 * Replays conversations into ACP updates, caching results so repeat loads of an
 * unchanged (or merely-extended) conversation are cheap.
 */
export class ReplayCache {
  private readonly cache: Lru<string, CacheEntry>;

  constructor(capacity: number) {
    this.cache = new Lru(capacity);
  }

  /** Replay a conversation, using/refreshing the cache. Null if unreadable. */
  get(dir: string, id: string, opts: ReplayOptions): ReplayResult | null {
    const stat = statConversation(dir, id);
    if (!stat) return null;

    const entry = this.cache.get(id);
    const sameOptions = entry?.skipNarration === opts.skipNarration && entry?.cwd === opts.cwd;

    if (entry && sameOptions) {
      // Fast path: file identical to what we cached.
      if (entry.stat.mtimeMs === stat.mtimeMs && entry.stat.size === stat.size) {
        return { updates: entry.updates, maxIdx: entry.maxIdx };
      }
      // Append path: file grew — translate only the new tail.
      if (stat.size >= entry.stat.size) {
        const appended = this.appendTail(dir, id, opts, entry, stat);
        if (appended) return appended;
      }
    }

    // Full (re)build.
    const built = buildReplay(dir, id, opts);
    if (!built) return null;
    this.store(id, built, stat, opts);
    return built;
  }

  /** Read steps past the cached high-water mark and append their translation. */
  private appendTail(
    dir: string,
    id: string,
    opts: ReplayOptions,
    entry: CacheEntry,
    stat: DbStat
  ): ReplayResult | null {
    const conn = ConversationDb.open(dir, id);
    if (!conn) return null;
    try {
      const newRows = conn.readAfter(entry.maxIdx);
      if (newRows.length === 0) {
        // Touched but no new steps (e.g. WAL checkpoint); just refresh the stat.
        const refreshed: ReplayResult = { updates: entry.updates, maxIdx: entry.maxIdx };
        this.store(id, refreshed, stat, opts);
        return refreshed;
      }
      const translator = new Translator({ mode: "replay", ...opts });
      const tail = translator.translate(newRows);
      const result: ReplayResult = {
        updates: entry.updates.concat(tail),
        maxIdx: Math.max(entry.maxIdx, translator.lastStepIdx)
      };
      this.store(id, result, stat, opts);
      return result;
    } finally {
      conn.close();
    }
  }

  private store(id: string, result: ReplayResult, stat: DbStat, opts: ReplayOptions): void {
    this.cache.set(id, { ...result, stat, skipNarration: opts.skipNarration, cwd: opts.cwd });
  }
}
