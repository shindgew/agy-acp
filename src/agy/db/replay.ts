// Full conversation-history replay for session/load, with a validated cache.
//
// Replays are cached per conversation and validated by file (mtime, size). On
// an exact cache hit the result is returned without touching SQLite. Any file
// change triggers a full rebuild so replay message grouping and mutable step
// snapshots do not depend on prior cache state.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { ConversationDb, type DbStat, statConversation } from "./database.js";
import { Lru } from "./lru.js";
import { isReadableFile } from "./tool-call-updates.js";
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
 * unchanged conversation are cheap.
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
      const locationsStillReadable = entry.updates.every((update) => {
        const locations = (update as SessionUpdate & { locations?: Array<{ path?: unknown }> }).locations ?? [];
        return locations.every((location) => typeof location.path === "string" && isReadableFile(location.path));
      });
      if (entry.stat.mtimeMs === stat.mtimeMs && entry.stat.size === stat.size && locationsStillReadable) {
        return { updates: entry.updates, maxIdx: entry.maxIdx };
      }
    }

    // Full (re)build.
    const built = buildReplay(dir, id, opts);
    if (!built) return null;
    this.store(id, built, stat, opts);
    return built;
  }

  private store(id: string, result: ReplayResult, stat: DbStat, opts: ReplayOptions): void {
    this.cache.set(id, { ...result, stat, skipNarration: opts.skipNarration, cwd: opts.cwd });
  }
}
