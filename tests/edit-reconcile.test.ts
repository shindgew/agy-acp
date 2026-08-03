import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_TEXT_BYTES,
  applyDiffBlockToSnapshot,
  applyDiffBlocksToSnapshot,
  buildReconcileEditUpdate,
  isValidUtf8,
  reconcileWorkingTree,
  replaceOccurrence,
  snapshotWorkingTree
} from "../src/agy/edit/reconcile.js";
import { diffBlocks } from "../src/agy/edit/revert.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-reconcile-"));
}

function gitRepo(): string {
  const dir = tmpDir();
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  return dir;
}

describe("reconcileWorkingTree", () => {
  it("reflects a modified tracked file with the pre-edit content as oldText", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(file, "after", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(unsupported).toEqual([]);
    expect(reflected).toEqual([{ path: file, oldText: "before", newText: "after" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reflects a newly created untracked file with oldText null", async () => {
    const dir = gitRepo();
    const baseline = await snapshotWorkingTree([dir]);
    const file = path.join(dir, "new.txt");
    fs.writeFileSync(file, "created", "utf8");

    const { reflected } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([{ path: file, oldText: null, newText: "created" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not re-emit a path after the baseline is advanced past a recognized edit", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(file, "after-structured", "utf8");
    // Advance from the structured diff content (not a disk reread).
    applyDiffBlockToSnapshot(baseline, file, "before", "after-structured");

    const { reflected } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("still reflects a later unstructured change after a recognized edit on the same path", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    // Structured edit mid, then a shell edit to final — both may be on disk
    // before the structured tool-call is observed. Baseline must advance from
    // the diff content, not a disk reread (which would see "final").
    fs.writeFileSync(file, "final", "utf8");
    applyDiffBlockToSnapshot(baseline, file, "before", "mid");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(unsupported).toEqual([]);
    expect(reflected).toEqual([{ path: file, oldText: "mid", newText: "final" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("applies partial replace snippets to the baseline without reading disk", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before\nOLD\nafter", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    // Disk already has a later shell edit; structured replace was OLD→NEW.
    fs.writeFileSync(file, "before\nSHELL\nafter", "utf8");
    applyDiffBlockToSnapshot(baseline, file, "OLD", "NEW");
    expect(baseline.get(file)?.text).toBe("before\nNEW\nafter");

    const { reflected } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([{ path: file, oldText: "before\nNEW\nafter", newText: "before\nSHELL\nafter" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("replaces the StartLine-targeted occurrence when a snippet repeats", () => {
    const text = "x\nOLD\ny\nOLD\nz";
    // First occurrence (default) — line 2.
    expect(replaceOccurrence(text, "OLD", "NEW")).toBe("x\nNEW\ny\nOLD\nz");
    // Second occurrence via StartLine 4.
    expect(replaceOccurrence(text, "OLD", "NEW", 4)).toBe("x\nOLD\ny\nNEW\nz");
    // applyDiffBlockToSnapshot carries the same line disambiguation.
    const snap = new Map([
      ["/r/a.txt", { sha1: "x", size: text.length, text }]
    ]);
    applyDiffBlockToSnapshot(snap, "/r/a.txt", "OLD", "NEW", 4);
    expect(snap.get("/r/a.txt")?.text).toBe("x\nOLD\ny\nNEW\nz");
  });

  it("applies multi-replace StartLines against the original text, not intermediate state", () => {
    // Line 2 is a 3-line block; replacing it with one line shifts later lines up.
    // Chunk 2's StartLine 6 is relative to the *original* file.
    const original = "keep\nAAA\nBBB\nCCC\nmid\nOLD\nend";
    // lines: 1 keep, 2 AAA, 3 BBB, 4 CCC, 5 mid, 6 OLD, 7 end
    const snap = new Map([
      ["/r/a.txt", { sha1: "x", size: original.length, text: original }]
    ]);
    applyDiffBlocksToSnapshot(snap, "/r/a.txt", [
      { oldText: "AAA\nBBB\nCCC", newText: "X", line: 2 },
      { oldText: "OLD", newText: "NEW", line: 6 }
    ]);
    expect(snap.get("/r/a.txt")?.text).toBe("keep\nX\nmid\nNEW\nend");
  });

  it("round-trips StartLine through diffBlocks when present on the content block", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "edit",
      status: "completed",
      content: [{ type: "diff", path: "/r/a.txt", oldText: "OLD", newText: "NEW", line: 4 }]
    };
    expect(diffBlocks(update as never)).toEqual([
      { path: "/r/a.txt", oldText: "OLD", newText: "NEW", line: 4 }
    ]);
  });

  it("ignores gitignored files", async () => {
    const dir = gitRepo();
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(path.join(dir, "ignored.txt"), "secret", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not invent a creation when removing an ignore rule exposes an existing file", async () => {
    const dir = gitRepo();
    const ignoreFile = path.join(dir, ".gitignore");
    const ignoredFile = path.join(dir, "ignored.txt");
    fs.writeFileSync(ignoreFile, "ignored.txt\n", "utf8");
    fs.writeFileSync(ignoredFile, "pre-existing", "utf8");
    execFileSync("git", ["-C", dir, "add", ".gitignore"]);

    const baseline = await snapshotWorkingTree([dir]);
    expect(baseline.has(ignoredFile)).toBe(false);
    fs.writeFileSync(ignoreFile, "", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([{ path: ignoreFile, oldText: "ignored.txt\n", newText: "" }]);
    expect(unsupported).toEqual([{ path: ignoredFile, reason: "ignore-rules-changed" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("retains ignore-change detection after a structured edit advances the baseline", async () => {
    const dir = gitRepo();
    const ignoreFile = path.join(dir, ".gitignore");
    const ignoredFile = path.join(dir, "ignored.txt");
    fs.writeFileSync(ignoreFile, "ignored.txt\n", "utf8");
    fs.writeFileSync(ignoredFile, "pre-existing", "utf8");
    execFileSync("git", ["-C", dir, "add", ".gitignore"]);

    const baseline = await snapshotWorkingTree([dir]);
    applyDiffBlockToSnapshot(baseline, ignoreFile, "ignored.txt\n", "");
    fs.writeFileSync(ignoreFile, "", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: ignoredFile, reason: "ignore-rules-changed" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("still reflects an unrelated creation when ignore rules also change", async () => {
    const dir = gitRepo();
    const ignoreFile = path.join(dir, ".gitignore");
    const createdFile = path.join(dir, "src", "new.ts");
    fs.writeFileSync(ignoreFile, "", "utf8");
    execFileSync("git", ["-C", dir, "add", ".gitignore"]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(ignoreFile, "dist/\n", "utf8");
    fs.mkdirSync(path.dirname(createdFile), { recursive: true });
    fs.writeFileSync(createdFile, "export {};\n", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toHaveLength(2);
    expect(reflected).toEqual(expect.arrayContaining([
      { path: ignoreFile, oldText: "", newText: "dist/\n" },
      { path: createdFile, oldText: null, newText: "export {};\n" }
    ]));
    expect(unsupported).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not report a baseline file as deleted when a new ignore rule hides it", async () => {
    const dir = gitRepo();
    const ignoreFile = path.join(dir, ".gitignore");
    const file = path.join(dir, "later-ignored.txt");
    fs.writeFileSync(ignoreFile, "", "utf8");
    fs.writeFileSync(file, "unchanged", "utf8");
    execFileSync("git", ["-C", dir, "add", ".gitignore"]);

    const baseline = await snapshotWorkingTree([dir]);
    expect(baseline.has(file)).toBe(true);
    fs.writeFileSync(ignoreFile, "later-ignored.txt\n", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([{ path: ignoreFile, oldText: "", newText: "later-ignored.txt\n" }]);
    expect(unsupported).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a binary change as unsupported instead of diffing it", async () => {
    const dir = gitRepo();
    const baseline = await snapshotWorkingTree([dir]);
    const file = path.join(dir, "blob.bin");
    fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x00]));

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "binary" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports invalid UTF-8 (NUL-free) as binary, not as text", async () => {
    const dir = gitRepo();
    const baseline = await snapshotWorkingTree([dir]);
    const file = path.join(dir, "bad.bin");
    // Lone 0xff is not valid UTF-8 and has no NUL — previously misclassified as text.
    fs.writeFileSync(file, Buffer.from([0xff]));

    expect(isValidUtf8(Buffer.from([0xff]))).toBe(false);
    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "binary" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a binary-to-text replacement as unsupported, not as a create", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "blob.bin");
    fs.writeFileSync(file, Buffer.from([0x00, 0x01]));
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    expect(baseline.get(file)?.text).toBeNull();
    fs.writeFileSync(file, "now text", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "binary" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports an oversized change as unsupported", async () => {
    const dir = gitRepo();
    const baseline = await snapshotWorkingTree([dir]);
    const file = path.join(dir, "big.txt");
    fs.writeFileSync(file, "a".repeat(MAX_TEXT_BYTES + 1), "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "oversized" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not buffer an oversized baseline file into memory as text", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "huge.bin");
    // Write just over the limit; snapshot must record size+null text without
    // treating it as routable text content.
    fs.writeFileSync(file, Buffer.alloc(MAX_TEXT_BYTES + 1, 1));
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    const snap = baseline.get(file);
    expect(snap).toBeDefined();
    expect(snap!.text).toBeNull();
    expect(snap!.size).toBe(MAX_TEXT_BYTES + 1);
    expect(snap!.sha1.startsWith("oversized:")).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("detects an oversized same-size replacement even when mtime is preserved", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "huge.bin");
    fs.writeFileSync(file, Buffer.alloc(MAX_TEXT_BYTES + 1, 1));
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    const originalTimes = fs.statSync(file);
    fs.writeFileSync(file, Buffer.alloc(MAX_TEXT_BYTES + 1, 2));
    fs.utimesSync(file, originalTimes.atime, originalTimes.mtime);

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "oversized" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a deleted file as unsupported", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.rmSync(file);

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "deleted" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves unchanged files alone", async () => {
    const dir = gitRepo();
    fs.writeFileSync(path.join(dir, "a.txt"), "same", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("works for a non-git root via the recursive-walk fallback", async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "dep.js"), "vendor", "utf8");

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(path.join(dir, "src.txt"), "hello", "utf8");
    // A change under node_modules must be skipped by the walk.
    fs.writeFileSync(path.join(dir, "node_modules", "dep.js"), "changed", "utf8");

    const { reflected } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([{ path: path.join(dir, "src.txt"), oldText: null, newText: "hello" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "deduplicates workspace roots that alias the same checkout",
    async () => {
      const dir = gitRepo();
      const aliasParent = tmpDir();
      const alias = path.join(aliasParent, "alias");
      fs.symlinkSync(dir, alias, "dir");
      const file = path.join(dir, "a.txt");
      const aliasedFile = path.join(alias, "a.txt");
      fs.writeFileSync(file, "before", "utf8");
      execFileSync("git", ["-C", dir, "add", "."]);

      // Keep the first spelling (cwd) while deduplicating by physical root.
      const baseline = await snapshotWorkingTree([alias, dir]);
      expect([...baseline.keys()].filter((p) => p.endsWith("a.txt"))).toEqual([aliasedFile]);
      fs.writeFileSync(file, "after", "utf8");
      // A structured tool may report the canonical absolute path even though
      // the workspace scan retained the cwd alias.
      applyDiffBlockToSnapshot(baseline, file, "before", "after");

      const { reflected, unsupported } = await reconcileWorkingTree(baseline, [alias, dir]);
      expect(unsupported).toEqual([]);
      expect(reflected).toEqual([]);

      fs.rmSync(aliasParent, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  );

  it.skipIf(process.platform === "win32")(
    "deduplicates files shared by overlapping aliased roots",
    async () => {
      const dir = gitRepo();
      const subdir = path.join(dir, "subdir");
      const aliasParent = tmpDir();
      const alias = path.join(aliasParent, "alias");
      fs.mkdirSync(subdir);
      fs.symlinkSync(subdir, alias, "dir");
      const file = path.join(subdir, "a.txt");
      const aliasedFile = path.join(alias, "a.txt");
      fs.writeFileSync(file, "before", "utf8");
      execFileSync("git", ["-C", dir, "add", "."]);

      const baseline = await snapshotWorkingTree([alias, dir]);
      expect([...baseline.keys()].filter((p) => p.endsWith("a.txt"))).toEqual([aliasedFile]);
      fs.writeFileSync(file, "after", "utf8");

      const { reflected, unsupported } = await reconcileWorkingTree(baseline, [alias, dir]);
      expect(unsupported).toEqual([]);
      expect(reflected).toEqual([{ path: aliasedFile, oldText: "before", newText: "after" }]);

      fs.rmSync(aliasParent, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  );

  it.skipIf(process.platform === "win32")(
    "aligns structured creations with the retained alias spelling",
    async () => {
      const dir = gitRepo();
      const subdir = path.join(dir, "subdir");
      const aliasParent = tmpDir();
      const alias = path.join(aliasParent, "alias");
      fs.mkdirSync(subdir);
      fs.symlinkSync(subdir, alias, "dir");
      const file = path.join(subdir, "new.txt");
      const aliasedFile = path.join(alias, "new.txt");
      const baseline = await snapshotWorkingTree([alias, dir]);
      fs.writeFileSync(file, "structured", "utf8");
      applyDiffBlockToSnapshot(baseline, file, null, "structured");

      expect(await reconcileWorkingTree(baseline, [alias, dir])).toEqual({ reflected: [], unsupported: [] });

      fs.writeFileSync(file, "later", "utf8");
      const { reflected, unsupported } = await reconcileWorkingTree(baseline, [alias, dir]);
      expect(unsupported).toEqual([]);
      expect(reflected).toEqual([{ path: aliasedFile, oldText: "structured", newText: "later" }]);

      fs.rmSync(aliasParent, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  );

  it("reports deletion of an in-root file created by a structured edit", async () => {
    const dir = gitRepo();
    const createdDir = path.join(dir, "created");
    const file = path.join(createdDir, "structured.txt");
    const baseline = await snapshotWorkingTree([dir]);
    fs.mkdirSync(createdDir);
    fs.writeFileSync(file, "created", "utf8");
    applyDiffBlockToSnapshot(baseline, file, null, "created");
    expect(baseline.get(file)?.candidate).toBe(false);
    fs.rmSync(createdDir, { recursive: true });

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "deleted" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not report a surviving ignored structured creation as deleted", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "ignored.txt");
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n", "utf8");
    execFileSync("git", ["-C", dir, "add", ".gitignore"]);
    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(file, "created", "utf8");
    applyDiffBlockToSnapshot(baseline, file, null, "created");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "uses structured physical identity after an in-root symlink to outside is removed",
    async () => {
      const dir = gitRepo();
      const outside = tmpDir();
      const link = path.join(dir, "link");
      const file = path.join(link, "outside.txt");
      fs.symlinkSync(outside, link, "dir");
      const baseline = await snapshotWorkingTree([dir]);
      fs.writeFileSync(file, "created", "utf8");
      applyDiffBlockToSnapshot(baseline, file, null, "created");
      fs.rmSync(file);
      fs.rmSync(link);

      expect(await reconcileWorkingTree(baseline, [dir])).toEqual({ reflected: [], unsupported: [] });

      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  );

  it.skipIf(process.platform === "win32")(
    "reports an in-root structured file replaced by an outside symlink as deleted",
    async () => {
      const dir = gitRepo();
      const outside = tmpDir();
      const file = path.join(dir, "structured.txt");
      const target = path.join(outside, "target.txt");
      const baseline = await snapshotWorkingTree([dir]);
      fs.writeFileSync(file, "created", "utf8");
      fs.writeFileSync(target, "outside", "utf8");
      applyDiffBlockToSnapshot(baseline, file, null, "created");
      fs.rmSync(file);
      fs.symlinkSync(target, file);

      const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
      expect(reflected).toEqual([]);
      expect(unsupported).toEqual([{ path: file, reason: "deleted" }]);
      expect(fs.readFileSync(target, "utf8")).toBe("outside");

      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  );

  it.skipIf(process.platform === "win32")(
    "does not read through a replaced parent directory symlink",
    async () => {
      const dir = gitRepo();
      const outside = tmpDir();
      const createdDir = path.join(dir, "created");
      const file = path.join(createdDir, "structured.txt");
      const target = path.join(outside, "structured.txt");
      const baseline = await snapshotWorkingTree([dir]);
      fs.mkdirSync(createdDir);
      fs.writeFileSync(file, "created", "utf8");
      applyDiffBlockToSnapshot(baseline, file, null, "created");
      fs.rmSync(createdDir, { recursive: true });
      fs.writeFileSync(target, "outside secret", "utf8");
      fs.symlinkSync(outside, createdDir, "dir");

      const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
      expect(reflected).toEqual([]);
      expect(unsupported).toEqual([{ path: file, reason: "deleted" }]);
      expect(fs.readFileSync(target, "utf8")).toBe("outside secret");

      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  );

  it("does not report structured-only baseline entries as deletions", async () => {
    const dir = gitRepo();
    const outside = tmpDir();
    const file = path.join(outside, "structured.txt");
    fs.writeFileSync(file, "created", "utf8");

    const baseline = await snapshotWorkingTree([dir]);
    applyDiffBlockToSnapshot(baseline, file, null, "created");
    expect(baseline.get(file)?.candidate).toBe(false);

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("does not follow a tracked symlink to a directory", async () => {
    const dir = gitRepo();
    const outside = tmpDir();
    fs.writeFileSync(path.join(outside, "secret.txt"), "nope", "utf8");
    // Symlink into the repo that points at an external directory.
    fs.symlinkSync(outside, path.join(dir, "linkdir"));
    execFileSync("git", ["-C", dir, "add", "-A"]);

    const baseline = await snapshotWorkingTree([dir]);
    // The symlink itself is not a regular file snapshot; external contents
    // must not be walked via symlink-following.
    expect([...baseline.keys()].some((p) => p.includes("secret.txt"))).toBe(false);
    expect(baseline.has(path.join(dir, "linkdir"))).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("does not follow a baseline file replaced by a symlink during direct resnapshot", async () => {
    const dir = gitRepo();
    const outside = tmpDir();
    const ignoreFile = path.join(dir, ".gitignore");
    const file = path.join(dir, "hidden.txt");
    const target = path.join(outside, "target.txt");
    fs.writeFileSync(ignoreFile, "", "utf8");
    fs.writeFileSync(file, "inside", "utf8");
    fs.writeFileSync(target, "outside secret", "utf8");
    execFileSync("git", ["-C", dir, "add", ".gitignore"]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.rmSync(file);
    fs.symlinkSync(target, file);
    fs.writeFileSync(ignoreFile, "hidden.txt\n", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir]);
    expect(reflected).toEqual([{ path: ignoreFile, oldText: "", newText: "hidden.txt\n" }]);
    expect(unsupported).toEqual([{ path: file, reason: "deleted" }]);
    expect(fs.readFileSync(target, "utf8")).toBe("outside secret");

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("recurses into a checked-out submodule without applying parent ignore rules", async () => {
    const root = tmpDir();
    const subSrc = path.join(root, "sub-src");
    const parent = path.join(root, "parent");
    fs.mkdirSync(subSrc);
    fs.mkdirSync(parent);

    execFileSync("git", ["-C", subSrc, "init", "-q"]);
    execFileSync("git", ["-C", subSrc, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", subSrc, "config", "user.name", "t"]);
    fs.writeFileSync(path.join(subSrc, "inside.txt"), "sub-before", "utf8");
    execFileSync("git", ["-C", subSrc, "add", "."]);
    execFileSync("git", ["-C", subSrc, "commit", "-qm", "sub"]);

    execFileSync("git", ["-C", parent, "init", "-q"]);
    execFileSync("git", ["-C", parent, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", parent, "config", "user.name", "t"]);
    fs.writeFileSync(path.join(parent, "root.txt"), "root", "utf8");
    execFileSync("git", ["-C", parent, "add", "."]);
    execFileSync("git", ["-C", parent, "commit", "-qm", "root"]);
    // protocol.file.allow must be on the invoking process (-c), not only the
    // repo config — submodule add clones via the file transport.
    execFileSync("git", [
      "-C", parent,
      "-c", "protocol.file.allow=always",
      "submodule", "add", subSrc, "vendor"
    ]);
    const parentIgnore = path.join(parent, ".gitignore");
    fs.writeFileSync(parentIgnore, "*.txt\n", "utf8");
    execFileSync("git", ["-C", parent, "add", ".gitignore"]);
    execFileSync("git", ["-C", parent, "commit", "-qm", "add vendor"]);

    const inside = path.join(parent, "vendor", "inside.txt");
    const created = path.join(parent, "vendor", "new.txt");
    const baseline = await snapshotWorkingTree([parent]);
    expect(baseline.has(inside)).toBe(true);

    // Parent ignore rules do not cross the nested repository boundary. Changing
    // the parent rule must not make the submodule creation look newly exposed.
    fs.writeFileSync(parentIgnore, "*.log\n", "utf8");
    fs.writeFileSync(inside, "sub-after", "utf8");
    fs.writeFileSync(created, "sub-created", "utf8");
    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [parent]);
    expect(unsupported).toEqual([]);
    expect(reflected).toHaveLength(3);
    expect(reflected).toEqual(expect.arrayContaining([
      { path: parentIgnore, oldText: "*.txt\n", newText: "*.log\n" },
      { path: inside, oldText: "sub-before", newText: "sub-after" },
      { path: created, oldText: null, newText: "sub-created" }
    ]));

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("buildReconcileEditUpdate", () => {
  it("produces a completed edit tool_call whose diff round-trips through diffBlocks", () => {
    const edit = { path: "/repo/src/a.txt", oldText: "old", newText: "new" };
    const update = buildReconcileEditUpdate(edit, 0, "/repo");

    expect(update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "agy-fs-reconcile-0",
      kind: "edit",
      status: "completed",
      title: "Edit src/a.txt"
    });
    expect(diffBlocks(update)).toEqual([{ path: "/repo/src/a.txt", oldText: "old", newText: "new" }]);
  });

  it("names a create (oldText null) write_to_file", () => {
    const update = buildReconcileEditUpdate({ path: "/repo/new.txt", oldText: null, newText: "x" }, 1, "/repo");
    expect(update).toMatchObject({ toolCallId: "agy-fs-reconcile-1", name: "write_to_file" });
  });

  it("qualifies the tool-call ID with a per-turn token when provided", () => {
    const edit = { path: "/repo/a.txt", oldText: null, newText: "x" };
    const turn0 = buildReconcileEditUpdate(edit, 0, "/repo", "0");
    const turn1 = buildReconcileEditUpdate(edit, 0, "/repo", "1");
    expect(turn0).toMatchObject({ toolCallId: "agy-fs-reconcile-0-0" });
    expect(turn1).toMatchObject({ toolCallId: "agy-fs-reconcile-1-0" });
    // Same index in different turns must not collide.
    expect((turn0 as { toolCallId: string }).toolCallId).not.toBe((turn1 as { toolCallId: string }).toolCallId);
  });

  it("keeps tool-call IDs unique when turn tokens are UUIDs (session reload safe)", () => {
    const edit = { path: "/repo/a.txt", oldText: null, newText: "x" };
    const a = buildReconcileEditUpdate(edit, 0, "/repo", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const b = buildReconcileEditUpdate(edit, 0, "/repo", "ffffffff-0000-1111-2222-333333333333");
    expect((a as { toolCallId: string }).toolCallId).toBe(
      "agy-fs-reconcile-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-0"
    );
    expect((a as { toolCallId: string }).toolCallId).not.toBe((b as { toolCallId: string }).toolCallId);
  });
});
