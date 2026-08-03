// Reflect *arbitrary* filesystem edits agy made during a turn — including ones
// that never surface as a recognized structured edit tool-call (e.g. edits made
// through `run_command` or an edit payload the translator doesn't decode). The
// edit/diff translator (db/tool-call-updates.ts) + bridge (edit/bridge.ts) only
// cover recognized edits; without this, Zed/Git can show files agy modified
// while ACP emits no corresponding diff update or fs/write-through (see #76).
//
// Strategy: snapshot the working tree at turn start, advance the baseline when
// a recognized edit lands, diff the remainder at turn end, and for every
// changed file synthesize an ACP `tool_call` edit update the caller can emit +
// hand to the client's fs write-through. Changes we can't represent as a text
// diff (binary/oversized/deletions) are reported to the caller so it can
// surface the limitation instead of silently dropping them.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

const execFileAsync = promisify(execFile);

/** Files larger than this are treated as out-of-scope (reported, not diffed). */
export const MAX_TEXT_BYTES = 1024 * 1024;
/** Directories never worth scanning for agy edits. */
const SKIP_DIRS = new Set([".git", "node_modules"]);

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface FileSnapshot {
  sha1: string;
  size: number;
  /** utf-8 contents, or null when binary or oversized (out of scope for a diff). */
  text: string | null;
}

/** Absolute file path -> snapshot. */
export type WorkingTreeSnapshot = Map<string, FileSnapshot>;

export interface ReflectedEdit {
  path: string;
  /** Pre-edit content; null when the file is newly created this turn. */
  oldText: string | null;
  newText: string;
}

export type UnsupportedReason = "binary" | "oversized" | "deleted";

export interface UnsupportedChange {
  path: string;
  reason: UnsupportedReason;
}

export interface ReconcileResult {
  reflected: ReflectedEdit[];
  unsupported: UnsupportedChange[];
}

function dedupeRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    const resolved = path.resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

/** True when `buf` is valid UTF-8 (and not empty of encoding errors). */
export function isValidUtf8(buf: Buffer): boolean {
  try {
    utf8Decoder.decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * List candidate files under a root. Prefers git (tracked + untracked but not
 * gitignored, so build output and node_modules stay out); falls back to a
 * bounded recursive walk for non-git roots. Checked-out submodules appear as
 * gitlink directories in the parent listing — expand them by listing inside.
 */
async function listFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 64 * 1024 * 1024 }
    );
    const out: string[] = [];
    for (const rel of stdout.split("\0")) {
      if (rel.length === 0) continue;
      const abs = path.resolve(root, rel);
      // Gitlinks (mode 160000) show up as a single path; when checked out that
      // path is a directory. Recurse so edits inside the submodule are visible.
      let st: import("node:fs").Stats | null = null;
      try {
        st = await fs.stat(abs);
      } catch {
        // vanished between ls-files and stat — skip
        continue;
      }
      if (st.isDirectory()) {
        out.push(...(await listFiles(abs)));
      } else if (st.isFile()) {
        out.push(abs);
      }
    }
    return out;
  } catch {
    return await walk(root);
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await walk(abs)));
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

async function snapshotFile(abs: string): Promise<FileSnapshot | null> {
  let st: import("node:fs").Stats;
  try {
    st = await fs.stat(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  // Never buffer multi-megabyte blobs into memory. Size+mtime is enough to
  // notice a change so we can report it as unsupported; we never text-diff them.
  if (st.size > MAX_TEXT_BYTES) {
    return {
      sha1: `oversized:${st.size}:${st.mtimeMs}`,
      size: st.size,
      text: null
    };
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch {
    return null; // unreadable / vanished / not a regular file
  }
  const sha1 = createHash("sha1").update(buf).digest("hex");
  // NUL byte *or* invalid UTF-8 => binary. Invalid UTF-8 must not be handed to
  // the client's text write-through (which would rewrite U+FFFD replacements).
  const isBinary = buf.includes(0) || !isValidUtf8(buf);
  const text = !isBinary ? buf.toString("utf8") : null;
  return { sha1, size: buf.length, text };
}

/**
 * Update (or remove) one path in an existing snapshot. Used after a recognized
 * structured edit lands so a later shell/unrecognized change to the same file
 * still reconciles against the post-edit content rather than being suppressed.
 */
export async function refreshSnapshotPath(
  snapshot: WorkingTreeSnapshot,
  filePath: string
): Promise<void> {
  const abs = path.resolve(filePath);
  const file = await snapshotFile(abs);
  if (file) snapshot.set(abs, file);
  else snapshot.delete(abs);
}

/** Snapshot the working tree across one or more roots. */
export async function snapshotWorkingTree(roots: string[]): Promise<WorkingTreeSnapshot> {
  const snapshot: WorkingTreeSnapshot = new Map();
  for (const root of dedupeRoots(roots)) {
    for (const abs of await listFiles(root)) {
      if (snapshot.has(abs)) continue;
      const file = await snapshotFile(abs);
      if (file) snapshot.set(abs, file);
    }
  }
  return snapshot;
}

/**
 * Diff the current working tree against a baseline snapshot. Callers that have
 * already reflected a recognized edit should {@link refreshSnapshotPath} the
 * baseline for that path first so only *further* changes are emitted.
 * Added/modified text files become `reflected` edits; binary/oversized/deleted
 * changes (and binary→text replacements we can't represent) become `unsupported`.
 */
export async function reconcileWorkingTree(
  baseline: WorkingTreeSnapshot,
  roots: string[]
): Promise<ReconcileResult> {
  const current = await snapshotWorkingTree(roots);
  const reflected: ReflectedEdit[] = [];
  const unsupported: UnsupportedChange[] = [];

  for (const [abs, now] of current) {
    const before = baseline.get(abs);
    if (before && before.sha1 === now.sha1) continue; // unchanged
    if (now.text === null) {
      unsupported.push({ path: abs, reason: now.size > MAX_TEXT_BYTES ? "oversized" : "binary" });
      continue;
    }
    // File existed before but was binary/oversized: we have no representable
    // oldText, and treating it as a create would mislead the client + corrupt
    // write-through. Report rather than invent a creation.
    if (before && before.text === null) {
      unsupported.push({
        path: abs,
        reason: before.size > MAX_TEXT_BYTES ? "oversized" : "binary"
      });
      continue;
    }
    reflected.push({ path: abs, oldText: before?.text ?? null, newText: now.text });
  }

  for (const [abs] of baseline) {
    if (!current.has(abs)) unsupported.push({ path: abs, reason: "deleted" });
  }

  return { reflected, unsupported };
}

/** Absolute path -> project-relative for display; unchanged if outside cwd. */
export function toDisplayPath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile === resolvedCwd || resolvedFile.startsWith(resolvedCwd + path.sep)) {
    return path.relative(resolvedCwd, resolvedFile);
  }
  return filePath;
}

/**
 * Build a synthetic completed-edit `tool_call` update for a reconciled change.
 * Shaped so {@link diffBlocks} (edit/revert.ts) reads it back and the client
 * fs write-through routes it exactly like a recognized edit. `turnToken`, when
 * provided, keeps the tool-call ID unique across turns in the same session.
 */
export function buildReconcileEditUpdate(
  edit: ReflectedEdit,
  index: number,
  cwd?: string,
  turnToken?: string
): SessionUpdate {
  const shown = toDisplayPath(edit.path, cwd);
  const suffix = turnToken !== undefined ? `${turnToken}-${index}` : `${index}`;
  return {
    sessionUpdate: "tool_call",
    toolCallId: `agy-fs-reconcile-${suffix}`,
    name: edit.oldText === null ? "write_to_file" : "edit",
    title: `Edit ${shown}`,
    kind: "edit",
    status: "completed",
    content: [{ type: "diff", path: edit.path, oldText: edit.oldText, newText: edit.newText }]
  } as unknown as SessionUpdate;
}
