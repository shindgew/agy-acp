// Undo an edit tool call that already landed on disk without a live agy
// confirmation gate (accept-edits / skip-permissions / any mode where agy
// didn't block). Used so edits_pending review still offers a real reject
// action in those cases instead of a no-op.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

export interface DiffBlock {
  path: string;
  oldText: string | null;
  newText: string;
}

export function diffBlocks(toolCall: SessionUpdate): DiffBlock[] {
  const raw = toolCall as unknown as { content?: unknown };
  const content = Array.isArray(raw.content) ? raw.content : [];
  const blocks: DiffBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type !== "diff") continue;
    const path = typeof block.path === "string" ? block.path : null;
    const newText = typeof block.newText === "string" ? block.newText : null;
    if (!path || newText === null) continue;
    const oldText = typeof block.oldText === "string" ? block.oldText : null;
    blocks.push({ path, oldText, newText });
  }
  return blocks;
}

/**
 * Restore the pre-edit text this same translator pass recorded for each diff
 * block. Only acts when the file's current content still matches what the
 * edit wrote — if it has diverged further (a later edit landed on top), the
 * block is left alone rather than guessing.
 */
export function revertEditToolCall(toolCall: SessionUpdate): void {
  for (const { path, oldText, newText } of diffBlocks(toolCall)) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current === null) continue;

    if (oldText === null) {
      // This block created the file; only remove it if nothing else touched
      // it since.
      if (current === newText) rmSync(path);
      continue;
    }

    if (current === newText) {
      writeFileSync(path, oldText, "utf8");
    } else if (current.includes(newText)) {
      writeFileSync(path, current.replace(newText, oldText), "utf8");
    }
  }
}
