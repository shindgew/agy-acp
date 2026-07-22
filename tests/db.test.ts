import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationDb } from "../src/db/database.js";
import { ReplayCache } from "../src/db/replay.js";
import { conversationSnapshot, newConversationId } from "../src/db/scan.js";
import { Translator } from "../src/db/translator.js";
import { createConversationDb, insertStep, updateStepPayload } from "./fixtures/conversation-db.js";
import { encodeAgentText, encodeStepPayload, encodeToolCall, encodeToolRun } from "./fixtures/step-encoder.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ConversationDb", () => {
  it("decodes agent text and tool-run rows from a real sqlite file", () => {
    const db = createConversationDb(dir, "conv-1");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "Hello" }) });
    insertStep(db, {
      idx: 2,
      stepType: 21,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({ callId: "c1", namePrimary: "run_command", rawInputJson: '{"CommandLine":"echo hi"}' })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-1");
    expect(conn).not.toBeNull();
    const rows = conn!.readAfter(0);
    conn!.close();

    expect(rows).toHaveLength(2);
    expect(rows[0].stepPayload.agentText?.text).toBe("Hello");
    expect(rows[1].stepPayload.toolRun?.call?.namePrimary).toBe("run_command");
    expect(rows[1].stepPayload.toolRun?.call?.rawInputJson).toBe('{"CommandLine":"echo hi"}');
  });

  it("returns null for a missing conversation", () => {
    expect(ConversationDb.open(dir, "does-not-exist")).toBeNull();
  });

  it("skips a row whose payload fails to decode instead of throwing, and retries it once fixed", () => {
    const db = createConversationDb(dir, "conv-corrupt");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "Hello" }) });
    const goodPayload = encodeStepPayload({
      toolRun: encodeToolRun({ call: encodeToolCall({ namePrimary: "run_command", rawInputJson: "{}" }) })
    });
    // Simulate a torn read of a row agy is still writing to: a submessage
    // truncated mid-field, which throws "premature EOF" while decoding.
    insertStep(db, { idx: 2, stepType: 21, stepPayload: goodPayload.slice(0, goodPayload.length - 2) });

    const conn = ConversationDb.open(dir, "conv-corrupt")!;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rows = conn.readAfter(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("failed to decode step 2"));
    errorSpy.mockRestore();

    expect(rows).toHaveLength(1);
    expect(rows[0].idx).toBe(1);

    updateStepPayload(db, 2, goodPayload);
    const retried = conn.readAfter(1);
    expect(retried).toHaveLength(1);
    expect(retried[0].stepPayload.toolRun?.call?.namePrimary).toBe("run_command");

    conn.close();
    db.close();
  });
});

describe("Translator", () => {
  it("streams only the newly-appended slice of a growing agent-text row", () => {
    const db = createConversationDb(dir, "conv-2");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "Hello" }) });

    const translator = new Translator({ mode: "stream", skipNarration: false });
    const conn = ConversationDb.open(dir, "conv-2")!;

    const first = translator.translate(conn.readAfter(0));
    expect(first).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } }]);

    updateStepPayload(db, 1, encodeStepPayload({ agentText: "Hello world" }));
    const second = translator.translate(conn.readAfter(0));
    expect(second).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } }]);

    conn.close();
    db.close();
  });

  it("dedupes tool-call steps across repeated polls in stream mode", () => {
    const db = createConversationDb(dir, "conv-3");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({ call: encodeToolCall({ namePrimary: "run_command", rawInputJson: "{}" }) })
      })
    });

    const translator = new Translator({ mode: "stream", skipNarration: false });
    const conn = ConversationDb.open(dir, "conv-3")!;

    expect(translator.translate(conn.readAfter(0))).toHaveLength(1);
    expect(translator.translate(conn.readAfter(0))).toHaveLength(0); // already emitted

    conn.close();
    db.close();
  });

  it("buffers consecutive agent-text parts into one message in replay mode", () => {
    const db = createConversationDb(dir, "conv-4");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "Hello" }) });
    insertStep(db, { idx: 2, stepType: 15, stepPayload: encodeStepPayload({ agentText: " world" }) });
    db.close();

    const conn = ConversationDb.open(dir, "conv-4")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello\n world" } }
    ]);
  });
});

describe("ReplayCache", () => {
  it("serves a cache hit without re-reading the file, and appends only the new tail on growth", () => {
    const db = createConversationDb(dir, "conv-5");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "Hello" }) });

    const cache = new ReplayCache(8);
    const first = cache.get(dir, "conv-5", { skipNarration: false });
    expect(first?.updates).toHaveLength(1);

    const cached = cache.get(dir, "conv-5", { skipNarration: false });
    expect(cached?.updates).toBe(first?.updates); // same array reference: fast path, no rebuild

    insertStep(db, { idx: 2, stepType: 15, stepPayload: encodeStepPayload({ agentText: " world" }) });
    db.close();

    const grown = cache.get(dir, "conv-5", { skipNarration: false });
    expect(grown?.updates).toHaveLength(2);
    expect(grown?.maxIdx).toBe(2);
  });

  it("returns null for a missing conversation", () => {
    const cache = new ReplayCache(8);
    expect(cache.get(dir, "missing", { skipNarration: false })).toBeNull();
  });
});

describe("conversation scan", () => {
  it("binds the single new .db file created since a snapshot", () => {
    createConversationDb(dir, "existing").close();
    const before = conversationSnapshot(dir);

    createConversationDb(dir, "fresh").close();
    expect(newConversationId(dir, before)).toBe("fresh");
  });

  it("refuses to bind when multiple new conversations appear", () => {
    const before = conversationSnapshot(dir);
    createConversationDb(dir, "a").close();
    createConversationDb(dir, "b").close();
    expect(newConversationId(dir, before)).toBeNull();
  });
});
