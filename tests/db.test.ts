import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationDb } from "../src/db/database.js";
import { ReplayCache } from "../src/db/replay.js";
import { conversationSnapshot, newConversationId } from "../src/db/scan.js";
import { Translator } from "../src/db/translator.js";
import { createConversationDb, insertStep, updateStep, updateStepPayload } from "./fixtures/conversation-db.js";
import {
  encodeAgentText,
  encodeCommandResult,
  encodePermissions,
  encodeStepPayload,
  encodeToolCall,
  encodeToolRun,
  encodeUrlContentResult,
  encodeViewFileResult,
  encodeWebSearchResult
} from "./fixtures/step-encoder.js";

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
    expect(first).toEqual([
      { sessionUpdate: "agent_message_chunk", messageId: "1", content: { type: "text", text: "Hello" } }
    ]);

    updateStepPayload(db, 1, encodeStepPayload({ agentText: "Hello world" }));
    const second = translator.translate(conn.readAfter(0));
    expect(second).toEqual([
      { sessionUpdate: "agent_message_chunk", messageId: "1", content: { type: "text", text: " world" } }
    ]);

    conn.close();
    db.close();
  });

  it("dedupes unchanged tool-call steps across repeated polls in stream mode", () => {
    const db = createConversationDb(dir, "conv-3");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 3,
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


  it("emits tool_call then tool_call_update when status progresses on the same idx", () => {
    const db = createConversationDb(dir, "conv-tool-progress");
    const call = encodeToolCall({
      callId: "cmd-1",
      namePrimary: "run_command",
      rawInputJson: '{"CommandLine":"echo hi"}'
    });
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 2, // in_progress
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({ call })
      })
    });

    const translator = new Translator({ mode: "stream", skipNarration: false });
    const conn = ConversationDb.open(dir, "conv-tool-progress")!;

    const first = translator.translate(conn.readAfter(0));
    expect(first).toMatchObject([
      {
        sessionUpdate: "tool_call",
        toolCallId: "cmd-1",
        kind: "execute",
        status: "in_progress",
        title: "echo hi"
      }
    ]);

    updateStep(db, 1, {
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({ call }),
        commandResult: encodeCommandResult({
          cwd: "/repo",
          exitCode: 0,
          output: "hi\n",
          command: "echo hi"
        })
      })
    });

    const second = translator.translate(conn.readAfter(0));
    expect(second).toMatchObject([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "cmd-1",
        kind: "execute",
        status: "completed",
        title: "echo hi"
      }
    ]);
    const content = (second[0] as { content?: Array<{ content?: { text?: string } }> }).content ?? [];
    const texts = content.map((c) => c.content?.text ?? "").join("\n");
    expect(texts).toContain("hi");

    // Unchanged snapshot: no third emission.
    expect(translator.translate(conn.readAfter(0))).toHaveLength(0);

    conn.close();
    db.close();
  });


  it("emits agent_thought_chunk for title-attached Think narration", () => {
    const db = createConversationDb(dir, "conv-thought");
    insertStep(db, {
      idx: 1,
      stepType: 23,
      stepPayload: encodeStepPayload({
        titleUpdate: "My session\n\nI will inspect the repo structure first."
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-thought")!;
    const translator = new Translator({ mode: "stream", skipNarration: false });
    const updates = translator.translate(conn.readAfter(0));
    conn.close();

    expect(updates).toEqual([
      { sessionUpdate: "session_info_update", title: "My session" },
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "title-thought-1",
        content: { type: "text", text: "I will inspect the repo structure first." }
      }
    ]);

    // Second poll: no duplicate thought/title.
    const conn2 = ConversationDb.open(dir, "conv-thought")!;
    expect(translator.translate(conn2.readAfter(0))).toHaveLength(0);
    conn2.close();
  });


  it("surfaces commandResult output on execute tool calls", () => {
    const db = createConversationDb(dir, "conv-exec-out");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "c-out",
            namePrimary: "run_command",
            rawInputJson: '{"CommandLine":"ls","Cwd":"/repo"}'
          })
        }),
        commandResult: encodeCommandResult({
          cwd: "/repo",
          exitCode: 0,
          output: "README.md\n",
          command: "ls"
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-exec-out")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as {
      sessionUpdate: string;
      kind: string;
      rawOutput?: { exitCode?: number; output?: string };
      content?: Array<{ content?: { text?: string } }>;
    };
    expect(update.sessionUpdate).toBe("tool_call");
    expect(update.kind).toBe("execute");
    expect(update.rawOutput).toMatchObject({ exitCode: 0, output: "README.md\n" });
    const body = (update.content ?? []).map((c) => c.content?.text ?? "").join("\n");
    expect(body).toContain("README.md");
  });

  it("surfaces web search query metadata from field 42", () => {
    const db = createConversationDb(dir, "conv-web-search");
    insertStep(db, {
      idx: 1,
      stepType: 33,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "ws-1",
            namePrimary: "search_web",
            rawInputJson: '{"query":"agy acp adapter"}'
          })
        }),
        webSearch: encodeWebSearchResult({
          query: "agy acp adapter",
          refinedQueryOrUrl: "https://www.google.com/search?q=agy+acp+adapter"
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-web-search")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as {
      kind: string;
      title: string;
      content?: Array<{ content?: { text?: string } }>;
    };
    expect(update.kind).toBe("search");
    expect(update.title).toContain("agy acp adapter");
    const body = (update.content ?? []).map((c) => c.content?.text ?? "").join("\n");
    expect(body).toContain("Query: agy acp adapter");
    expect(body).toContain("https://www.google.com/search");
  });


  it("surfaces fetched URL body from field 40", () => {
    const db = createConversationDb(dir, "conv-fetch");
    insertStep(db, {
      idx: 1,
      stepType: 31,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "fetch-1",
            namePrimary: "read_url_content",
            rawInputJson: '{"Url":"https://example.com/doc"}'
          })
        }),
        urlContent: encodeUrlContentResult({
          url: "https://example.com/doc",
          title: "Example Doc",
          description: "Fetched live",
          body: "# Hello\n\nBody from the page."
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-fetch")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as {
      kind: string;
      title: string;
      rawOutput?: { title?: string; truncated?: boolean };
      content?: Array<{ content?: { text?: string } }>;
    };
    expect(update.kind).toBe("fetch");
    expect(update.title).toContain("Example Doc");
    expect(update.rawOutput).toMatchObject({ title: "Example Doc" });
    const body = (update.content ?? []).map((c) => c.content?.text ?? "").join("\n");
    expect(body).toContain("https://example.com/doc");
    expect(body).toContain("Body from the page.");
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
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "Hello\n world" }
      }
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
