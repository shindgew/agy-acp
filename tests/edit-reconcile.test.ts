import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_TEXT_BYTES,
  buildReconcileEditUpdate,
  reconcileWorkingTree,
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

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir], []);
    expect(unsupported).toEqual([]);
    expect(reflected).toEqual([{ path: file, oldText: "before", newText: "after" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reflects a newly created untracked file with oldText null", async () => {
    const dir = gitRepo();
    const baseline = await snapshotWorkingTree([dir]);
    const file = path.join(dir, "new.txt");
    fs.writeFileSync(file, "created", "utf8");

    const { reflected } = await reconcileWorkingTree(baseline, [dir], []);
    expect(reflected).toEqual([{ path: file, oldText: null, newText: "created" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips a path already reflected by a recognized edit", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(file, "after", "utf8");

    const { reflected } = await reconcileWorkingTree(baseline, [dir], [file]);
    expect(reflected).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ignores gitignored files", async () => {
    const dir = gitRepo();
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(path.join(dir, "ignored.txt"), "secret", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir], []);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a binary change as unsupported instead of diffing it", async () => {
    const dir = gitRepo();
    const baseline = await snapshotWorkingTree([dir]);
    const file = path.join(dir, "blob.bin");
    fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x00]));

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir], []);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "binary" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports an oversized change as unsupported", async () => {
    const dir = gitRepo();
    const baseline = await snapshotWorkingTree([dir]);
    const file = path.join(dir, "big.txt");
    fs.writeFileSync(file, "a".repeat(MAX_TEXT_BYTES + 1), "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir], []);
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

    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir], []);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "deleted" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves unchanged files alone", async () => {
    const dir = gitRepo();
    fs.writeFileSync(path.join(dir, "a.txt"), "same", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    const { reflected, unsupported } = await reconcileWorkingTree(baseline, [dir], []);
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

    const { reflected } = await reconcileWorkingTree(baseline, [dir], []);
    expect(reflected).toEqual([{ path: path.join(dir, "src.txt"), oldText: null, newText: "hello" }]);

    fs.rmSync(dir, { recursive: true, force: true });
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
});
