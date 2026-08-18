// Fork an agy conversation database and associated brain artifacts.
// Used by ACP session/fork to create an independent branch of an existing session.

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { conversationDbPath } from "./database.js";

/**
 * Fork an existing agy conversation database and brain artifacts directory into a new conversation ID.
 * Uses SQLite's online backup API for an atomic, consistent snapshot without torn reads.
 */
export async function forkConversation(
  conversationsDir: string,
  sourceConversationId: string,
  targetConversationId: string,
  brainBaseDir?: string
): Promise<void> {
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

  // 2. Update trajectory_meta in destination DB
  try {
    const destDb = new Database(destDbPath);
    try {
      const hasMeta = destDb
        .prepare(
          "SELECT COUNT(*) > 0 AS present FROM sqlite_master WHERE type='table' AND name='trajectory_meta'"
        )
        .get() as { present: number } | undefined;
      if (hasMeta?.present) {
        destDb
          .prepare("UPDATE trajectory_meta SET cascade_id = ?")
          .run(targetConversationId);
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
}
