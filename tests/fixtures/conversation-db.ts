// Builds a throwaway agy-shaped conversation SQLite database for tests.

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

export function createConversationDb(dir: string, id: string): Database.Database {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, `${id}.db`));
  db.exec(
    "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, " +
      "step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)"
  );
  return db;
}

export function insertStep(
  db: Database.Database,
  row: { idx: number; stepType: number; status?: number; stepPayload: Uint8Array }
): void {
  db.prepare(
    "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)"
  ).run(row.idx, row.stepType, row.status ?? 3, Buffer.from(row.stepPayload));
}

export function updateStepPayload(db: Database.Database, idx: number, stepPayload: Uint8Array): void {
  db.prepare("UPDATE steps SET step_payload = ? WHERE idx = ?").run(Buffer.from(stepPayload), idx);
}
