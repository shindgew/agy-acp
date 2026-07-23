import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import {
  primeEditReadThroughClient,
  routeEditThroughClient,
  writeEditThroughClient,
  type ClientFileSystem
} from "../src/file-system/bridge.js";

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

function recordingBridge() {
  const reads: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const bridge: ClientFileSystem = {
    readTextFile: async (p) => { reads.push(p); },
    writeTextFile: async (p, content) => {
      writes.push({ path: p, content });
      fs.writeFileSync(p, content, "utf8");
    }
  };
  return { bridge, reads, writes };
}

describe("routeEditThroughClient", () => {
  it("reverts to old text, reads, then writes the full post-edit content back through the client", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fsbridge-"));
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before\nNEW\nafter", "utf8");
    const { bridge, reads, writes } = recordingBridge();
    const seenDuringRead: string[] = [];
    const wrapped: ClientFileSystem = {
      readTextFile: async (p) => {
        seenDuringRead.push(fs.readFileSync(p, "utf8"));
        await bridge.readTextFile(p);
      },
      writeTextFile: bridge.writeTextFile
    };

    const routed = await routeEditThroughClient(
      diffToolCall([{ path: file, oldText: "OLD", newText: "NEW" }]),
      wrapped
    );

    expect(routed).toBe(true);
    // Disk read as "old" during the read call (pre-edit state), so the
    // client's diff is computed against the real before/after.
    expect(seenDuringRead).toEqual(["before\nOLD\nafter"]);
    expect(reads).toEqual([file]);
    expect(writes).toEqual([{ path: file, content: "before\nNEW\nafter" }]);
    // The client "wrote" the final content itself.
    expect(fs.readFileSync(file, "utf8")).toBe("before\nNEW\nafter");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("handles a full-file create (oldText null) by reverting to empty before the write-through", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fsbridge-"));
    const file = path.join(dir, "new.txt");
    fs.writeFileSync(file, "created", "utf8");
    const { bridge, writes } = recordingBridge();

    const routed = await routeEditThroughClient(
      diffToolCall([{ path: file, oldText: null, newText: "created" }]),
      bridge
    );

    expect(routed).toBe(true);
    expect(writes).toEqual([{ path: file, content: "created" }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the file alone and returns false when content has diverged since the edit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fsbridge-"));
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "something else entirely", "utf8");
    const { bridge, writes } = recordingBridge();

    const routed = await routeEditThroughClient(
      diffToolCall([{ path: file, oldText: "old", newText: "new" }]),
      bridge
    );

    expect(routed).toBe(false);
    expect(writes).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe("something else entirely");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns false and restores the post-edit content when the client rejects the write", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fsbridge-"));
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before\nNEW\nafter", "utf8");
    const bridge: ClientFileSystem = {
      readTextFile: async () => {},
      writeTextFile: async () => { throw new Error("client rejected"); }
    };

    const routed = await routeEditThroughClient(
      diffToolCall([{ path: file, oldText: "OLD", newText: "NEW" }]),
      bridge
    );

    expect(routed).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("before\nNEW\nafter");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns false when there are no diff content blocks", async () => {
    const { bridge } = recordingBridge();
    const routed = await routeEditThroughClient(
      { sessionUpdate: "tool_call", toolCallId: "x", title: "Edit", kind: "edit", status: "completed", content: [] } as unknown as SessionUpdate,
      bridge
    );
    expect(routed).toBe(false);
  });
});

describe("primeEditReadThroughClient + writeEditThroughClient", () => {
  it("reads the referenced path(s) without touching disk, deduped across blocks", async () => {
    const { bridge, reads, writes } = recordingBridge();
    await primeEditReadThroughClient(
      diffToolCall([
        { path: "/repo/a.txt", oldText: "old", newText: "new" },
        { path: "/repo/a.txt", oldText: "old2", newText: "new2" }
      ]),
      bridge
    );
    expect(reads).toEqual(["/repo/a.txt"]);
    expect(writes).toEqual([]);
  });

  it("writes the current on-disk content through the client without reverting or re-reading first", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-fsbridge-"));
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before\nNEW\nafter", "utf8");
    const { bridge, reads, writes } = recordingBridge();

    const routed = await writeEditThroughClient(
      diffToolCall([{ path: file, oldText: "OLD", newText: "NEW" }]),
      bridge
    );

    expect(routed).toBe(true);
    expect(reads).toEqual([]);
    expect(writes).toEqual([{ path: file, content: "before\nNEW\nafter" }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writeEditThroughClient returns false when the file no longer exists", async () => {
    const { bridge } = recordingBridge();
    const routed = await writeEditThroughClient(
      diffToolCall([{ path: "/nonexistent/gone.txt", oldText: "old", newText: "new" }]),
      bridge
    );
    expect(routed).toBe(false);
  });
});
