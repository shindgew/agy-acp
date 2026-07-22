import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { revertEditToolCall } from "../src/edit-revert.js";

function diffToolCall(blocks: Array<{ path: string; oldText: string | null; newText: string }>): SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: "x",
    title: "Edit",
    kind: "edit",
    status: "completed",
    content: blocks.map((b) => ({ type: "diff" as const, ...b }))
  } as SessionUpdate;
}

describe("revertEditToolCall", () => {
  it("restores the prior full-file content", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-revert-"));
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "new content", "utf8");

    revertEditToolCall(diffToolCall([{ path: file, oldText: "old content", newText: "new content" }]));

    expect(fs.readFileSync(file, "utf8")).toBe("old content");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reverts a chunked replace by substring", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-revert-"));
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before\nNEW\nafter", "utf8");

    revertEditToolCall(diffToolCall([{ path: file, oldText: "OLD", newText: "NEW" }]));

    expect(fs.readFileSync(file, "utf8")).toBe("before\nOLD\nafter");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("deletes a file that was newly created (oldText null)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-revert-"));
    const file = path.join(dir, "new.txt");
    fs.writeFileSync(file, "created", "utf8");

    revertEditToolCall(diffToolCall([{ path: file, oldText: null, newText: "created" }]));

    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the file alone when content has diverged since the edit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-revert-"));
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "something else entirely", "utf8");

    revertEditToolCall(diffToolCall([{ path: file, oldText: "old", newText: "new" }]));

    expect(fs.readFileSync(file, "utf8")).toBe("something else entirely");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("no-ops when the file no longer exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-revert-"));
    const file = path.join(dir, "gone.txt");

    expect(() => revertEditToolCall(diffToolCall([{ path: file, oldText: "old", newText: "new" }]))).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
