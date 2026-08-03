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
import { createReadStream, promises as fs } from "node:fs";
import * as os from "node:os";
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
  /** False when added by structured-diff advancement rather than root listing. */
  candidate?: boolean;
  /** Original listed fingerprint, retained when structured diffs advance sha1. */
  initialSha1?: string;
  /** Original listed text, retained to evaluate pre-turn ignore rules. */
  initialText?: string | null;
}

/** Absolute file path -> snapshot. */
export type WorkingTreeSnapshot = Map<string, FileSnapshot>;

export interface ReflectedEdit {
  path: string;
  /** Pre-edit content; null when the file is newly created this turn. */
  oldText: string | null;
  newText: string;
}

export type UnsupportedReason = "binary" | "oversized" | "deleted" | "ignore-rules-changed";

export interface UnsupportedChange {
  path: string;
  reason: UnsupportedReason;
}

export interface ReconcileResult {
  reflected: ReflectedEdit[];
  unsupported: UnsupportedChange[];
}

async function dedupeRoots(roots: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    const resolved = path.resolve(root);
    let canonical = resolved;
    try {
      canonical = await fs.realpath(resolved);
    } catch {
      // Preserve the unresolved root so the existing git/walk fallback can
      // decide whether it is readable.
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    // Keep the first configured spelling (normally cwd) for emitted paths.
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
 * Symlinks are never followed (a tracked symlink to a directory is not a
 * gitlink; following it can loop or walk outside the configured roots).
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
      // lstat: do not follow symlinks. Gitlinks (mode 160000) show up as a
      // single path; when checked out that path is a real directory.
      let st: import("node:fs").Stats | null = null;
      try {
        st = await fs.lstat(abs);
      } catch {
        // vanished between ls-files and lstat — skip
        continue;
      }
      if (st.isSymbolicLink()) continue;
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
    // Do not follow a regular-file path that was replaced with a symlink after
    // the baseline listing, especially during direct candidate resnapshot.
    st = await fs.lstat(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  // Never buffer multi-megabyte blobs into memory. Hash them as a stream so a
  // same-size replacement with a preserved/coarse mtime is still reported.
  if (st.size > MAX_TEXT_BYTES) {
    try {
      const hash = createHash("sha1");
      for await (const chunk of createReadStream(abs)) hash.update(chunk);
      const sha1 = `oversized:${st.size}:${hash.digest("hex")}`;
      return { sha1, size: st.size, text: null, candidate: true, initialSha1: sha1, initialText: null };
    } catch {
      return null;
    }
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
  return { sha1, size: buf.length, text, candidate: true, initialSha1: sha1, initialText: text };
}

function snapshotFromText(
  text: string,
  candidate: boolean,
  initialSha1?: string,
  initialText?: string | null
): FileSnapshot {
  const buf = Buffer.from(text, "utf8");
  if (buf.length > MAX_TEXT_BYTES) {
    const sha1 = `oversized:${buf.length}:${createHash("sha1").update(buf).digest("hex")}`;
    return { sha1, size: buf.length, text: null, candidate, initialSha1, initialText };
  }
  const sha1 = createHash("sha1").update(buf).digest("hex");
  return {
    sha1,
    size: buf.length,
    text,
    candidate,
    initialSha1,
    initialText
  };
}

/**
 * Byte offset of the start of 1-based line `line` in `text`, or null if the
 * file has fewer lines.
 */
function offsetOfLine(text: string, line: number): number | null {
  if (line < 1) return null;
  if (line === 1) return 0;
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const nl = text.indexOf("\n", offset);
    if (nl === -1) return null;
    offset = nl + 1;
  }
  return offset;
}

/**
 * Replace one occurrence of `oldText` with `newText`. When `line` is set
 * (1-based), search starts at that line so a later repeated snippet is chosen
 * over the first match — matching agy `StartLine` on replace chunks.
 */
export function replaceOccurrence(
  text: string,
  oldText: string,
  newText: string,
  line?: number
): string | null {
  const from = line !== undefined ? offsetOfLine(text, line) : 0;
  if (from === null) return null;
  const idx = text.indexOf(oldText, from);
  if (idx === -1) return null;
  return text.slice(0, idx) + newText + text.slice(idx + oldText.length);
}

export interface DiffBlockSpec {
  oldText: string | null;
  newText: string;
  /** 1-based start line in the *pre-edit* file (agy StartLine). */
  line?: number;
}

/**
 * Advance a snapshot entry to the post-edit content described by a structured
 * diff block, without reading disk. Disk may already include later shell edits
 * by the time the structured tool-call is polled; rereading would advance past
 * those too and suppress the synthetic update for them.
 *
 * `oldText`/`newText` may be whole-file bodies (`write_to_file`) or replacement
 * snippets (`replace_file_content`). Optional `line` (1-based) selects which
 * occurrence of a repeated snippet was replaced.
 */
export function applyDiffBlockToSnapshot(
  snapshot: WorkingTreeSnapshot,
  filePath: string,
  oldText: string | null,
  newText: string,
  line?: number
): void {
  applyDiffBlocksToSnapshot(snapshot, filePath, [{ oldText, newText, line }]);
}

/**
 * Apply one or more structured diff blocks for a single path. Multi-replace
 * chunks carry `StartLine` against the *original* file; applying them left-to-
 * right on a mutating buffer can invalidate later line numbers when an earlier
 * chunk changes the line count. Instead, locate every match on the original
 * text and apply from end to start so indices stay valid.
 */
export function applyDiffBlocksToSnapshot(
  snapshot: WorkingTreeSnapshot,
  filePath: string,
  blocks: DiffBlockSpec[]
): void {
  if (blocks.length === 0) return;

  const abs = path.resolve(filePath);
  const before = snapshot.get(abs);

  // Full-file writes (oldText null) and missing/binary baselines cannot use
  // multi-match positioning — fall back to sequential single-block rules.
  if (blocks.some((b) => b.oldText === null) || before?.text == null) {
    for (const block of blocks) {
      applySingleDiffBlock(snapshot, abs, snapshot.get(abs), block);
    }
    return;
  }

  const original = before.text;
  type Op = { idx: number; oldLen: number; newText: string };
  const ops: Op[] = [];

  for (const block of blocks) {
    const oldText = block.oldText!;
    if (original === oldText) {
      ops.push({ idx: 0, oldLen: original.length, newText: block.newText });
      continue;
    }
    const from = block.line !== undefined ? offsetOfLine(original, block.line) : 0;
    if (from === null) continue;
    const idx = original.indexOf(oldText, from);
    if (idx === -1) continue;
    ops.push({ idx, oldLen: oldText.length, newText: block.newText });
  }

  if (ops.length === 0) {
    // Nothing matched — same best-effort as a single failed apply.
    const last = blocks[blocks.length - 1]!;
    if (original === last.newText || original.includes(last.newText)) return;
    return;
  }

  // End-to-start so earlier replacements do not shift later indices.
  ops.sort((a, b) => b.idx - a.idx || b.oldLen - a.oldLen);
  let result = original;
  for (const op of ops) {
    result = result.slice(0, op.idx) + op.newText + result.slice(op.idx + op.oldLen);
  }
  snapshot.set(
    abs,
    snapshotFromText(
      result,
      before.candidate !== false,
      before.initialSha1 ?? before.sha1,
      before.initialText ?? before.text
    )
  );
}

function applySingleDiffBlock(
  snapshot: WorkingTreeSnapshot,
  abs: string,
  before: FileSnapshot | undefined,
  block: DiffBlockSpec
): void {
  const { oldText, newText, line } = block;
  let post: string;

  if (oldText === null) {
    post = newText;
  } else if (before?.text != null) {
    if (before.text === oldText) {
      post = newText;
    } else {
      const applied = replaceOccurrence(before.text, oldText, newText, line);
      if (applied !== null) {
        post = applied;
      } else if (before.text === newText || before.text.includes(newText)) {
        return;
      } else {
        return;
      }
    }
  } else {
    post = newText;
  }

  snapshot.set(
    abs,
    snapshotFromText(
      post,
      before?.candidate ?? false,
      before ? (before.initialSha1 ?? before.sha1) : undefined,
      before ? (before.initialText ?? before.text) : undefined
    )
  );
}

/** Snapshot the working tree across one or more roots. */
export async function snapshotWorkingTree(roots: string[]): Promise<WorkingTreeSnapshot> {
  const snapshot: WorkingTreeSnapshot = new Map();
  for (const root of await dedupeRoots(roots)) {
    for (const abs of await listFiles(root)) {
      if (snapshot.has(abs)) continue;
      const file = await snapshotFile(abs);
      if (file) snapshot.set(abs, file);
    }
  }
  return snapshot;
}

/**
 * Use Git's own matcher to determine which newly listed paths were ignored by
 * the pre-turn .gitignore contents. Reconstructing only ignore files in a
 * temporary repository avoids mutating the real worktree and avoids a partial
 * reimplementation of gitignore pattern/negation semantics.
 */
async function ignoredByBaselineRules(
  baseline: WorkingTreeSnapshot,
  candidates: string[]
): Promise<Set<string>> {
  const ignored = new Set<string>();
  const byRepository = new Map<string, Array<{ abs: string; canonical: string }>>();
  for (const abs of candidates) {
    try {
      const canonical = path.join(await fs.realpath(path.dirname(abs)), path.basename(abs));
      const { stdout } = await execFileAsync(
        "git",
        ["-C", path.dirname(abs), "rev-parse", "--show-toplevel"]
      );
      const repository = path.resolve(stdout.trim());
      const existing = byRepository.get(repository);
      const candidate = { abs, canonical };
      if (existing) existing.push(candidate);
      else byRepository.set(repository, [candidate]);
    } catch {
      // Non-git roots use the recursive walker, where .gitignore never changes
      // candidate visibility.
    }
  }

  for (const [repository, repositoryCandidates] of byRepository) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agy-acp-ignore-"));
    try {
      await execFileAsync("git", ["-C", temp, "init", "-q"]);
      for (const [ignoreFile, snapshot] of baseline) {
        let canonicalIgnoreFile: string;
        try {
          canonicalIgnoreFile = path.join(
            await fs.realpath(path.dirname(ignoreFile)),
            path.basename(ignoreFile)
          );
        } catch {
          continue;
        }
        if (
          path.basename(ignoreFile) !== ".gitignore" ||
          (canonicalIgnoreFile !== path.join(repository, ".gitignore") &&
            !canonicalIgnoreFile.startsWith(repository + path.sep))
        ) continue;
        const text = snapshot.initialText ?? snapshot.text;
        if (text == null) continue;
        const relative = path.relative(repository, canonicalIgnoreFile);
        const target = path.join(temp, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, text, "utf8");
      }

      for (const { abs, canonical } of repositoryCandidates) {
        const relative = path.relative(repository, canonical);
        try {
          await execFileAsync("git", ["-C", temp, "check-ignore", "-q", "--no-index", "--", relative]);
          ignored.add(abs);
        } catch {
          // Exit 1 means the path was visible under the baseline rules. Other
          // matcher failures conservatively leave it eligible for reflection.
        }
      }
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
  return ignored;
}

/**
 * Diff the current working tree against a baseline snapshot. Callers that have
 * already reflected a recognized edit should {@link applyDiffBlockToSnapshot}
 * the baseline for that path first so only *further* changes are emitted.
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

  // A newly added ignore rule can remove a still-existing baseline candidate
  // from `git ls-files --others --exclude-standard`. Snapshot those paths
  // directly so an eligibility change is not misreported as a deletion.
  for (const [abs, before] of baseline) {
    if (current.has(abs)) continue;
    // Structured baseline advancement can add an absolute path outside the
    // configured roots. It was never a listing candidate, so do not pull it
    // into reconciliation and duplicate the already-routed structured edit.
    if (before.candidate === false) continue;
    const now = await snapshotFile(abs);
    if (now) current.set(abs, now);
  }

  // Conversely, removing an ignore rule can expose a pre-existing file that
  // was absent from the baseline. We cannot reconstruct its pre-turn content,
  // so report it rather than inventing a creation and routing a destructive
  // empty→content write-through. Nested .gitignore changes affect descendants.
  const changedIgnoreRules = new Set<string>();
  const paths = new Set([...baseline.keys(), ...current.keys()]);
  for (const abs of paths) {
    if (path.basename(abs) !== ".gitignore") continue;
    const before = baseline.get(abs);
    if ((before?.initialSha1 ?? before?.sha1) !== current.get(abs)?.sha1) changedIgnoreRules.add(abs);
  }
  const couldBeAffectedByIgnoreChange = (abs: string): boolean => {
    if (path.basename(abs) === ".gitignore") return false;
    for (const ignoreFile of changedIgnoreRules) {
      const dir = path.dirname(ignoreFile);
      if (abs.startsWith(dir + path.sep)) return true;
    }
    return false;
  };
  const newlyListedAfterIgnoreChange = [...current.keys()].filter(
    (abs) => !baseline.has(abs) && couldBeAffectedByIgnoreChange(abs)
  );
  const ignoredBeforeTurn = await ignoredByBaselineRules(baseline, newlyListedAfterIgnoreChange);

  for (const [abs, now] of current) {
    const before = baseline.get(abs);
    if (before && before.sha1 === now.sha1) continue; // unchanged
    if (!before && ignoredBeforeTurn.has(abs)) {
      unsupported.push({ path: abs, reason: "ignore-rules-changed" });
      continue;
    }
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
