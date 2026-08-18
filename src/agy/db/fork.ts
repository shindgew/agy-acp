// Fork an agy conversation database and associated brain artifacts.
// Used by ACP session/fork to create an independent branch of an existing session.

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { conversationDbPath } from "./database.js";

export interface ForkedConversation {
  /** Highest `steps.idx` present in the copied database, or -1 if none. */
  maxStepIdx: number;
}

/**
 * Fork an existing agy conversation database and brain artifacts directory into a new conversation ID.
 * Uses SQLite's online backup API for an atomic, consistent snapshot without torn reads.
 *
 * `agy` has no fork flag — it resumes a conversation by `--conversation <id>`
 * against `~/.gemini/antigravity-cli/conversations/<id>.db`. The child must
 * therefore be a new conversation id whose DB is a consistent snapshot, and
 * whose ACP cursor is not behind that snapshot.
 */
export async function forkConversation(
  conversationsDir: string,
  sourceConversationId: string,
  targetConversationId: string,
  brainBaseDir?: string
): Promise<ForkedConversation> {
  const srcDbPath = conversationDbPath(conversationsDir, sourceConversationId);
  const destDbPath = conversationDbPath(conversationsDir, targetConversationId);

  if (!fs.existsSync(srcDbPath)) {
    throw new Error(`Source conversation database not found: ${sourceConversationId}`);
  }

  await fs.promises.mkdir(conversationsDir, { recursive: true });

  // 1. Safe atomic snapshot of SQLite DB
  const srcDb = new Database(srcDbPath, { readonly: true, fileMustExist: true });
  try {
    await srcDb.backup(destDbPath);
  } finally {
    srcDb.close();
  }

  // 2. Rebind trajectory_meta.cascade_id (agy identity for this file) and
  //    read the snapshot cursor from the copied steps table.
  let maxStepIdx = -1;
  try {
    const destDb = new Database(destDbPath);
    try {
      const tables = destDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('trajectory_meta', 'steps')"
        )
        .all() as Array<{ name: string }>;
      const names = new Set(tables.map((table) => table.name));
      if (names.has("trajectory_meta")) {
        destDb.prepare("UPDATE trajectory_meta SET cascade_id = ?").run(targetConversationId);
      }
      if (names.has("steps")) {
        const row = destDb.prepare("SELECT MAX(idx) AS maxIdx FROM steps").get() as
          | { maxIdx: number | null }
          | undefined;
        if (typeof row?.maxIdx === "number") maxStepIdx = row.maxIdx;
      }
    } finally {
      destDb.close();
    }
  } catch (error) {
    console.error(
      `[agy-acp] WARN: failed to update trajectory_meta in forked db ${targetConversationId}: ${(error as Error).message}`
    );
  }

  // 3. Copy brain artifacts directory if present
  const resolvedBrainBase =
    brainBaseDir ?? path.join(path.dirname(conversationsDir), "brain");
  const srcBrainDir = path.join(resolvedBrainBase, sourceConversationId);
  const destBrainDir = path.join(resolvedBrainBase, targetConversationId);

  try {
    if (fs.existsSync(srcBrainDir)) {
      await fs.promises.cp(srcBrainDir, destBrainDir, { recursive: true });
    }
  } catch (error) {
    console.error(
      `[agy-acp] WARN: failed to copy brain artifacts for forked conversation ${targetConversationId}: ${(error as Error).message}`
    );
  }

  return { maxStepIdx };
}
