import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationDb } from "../src/agy/db/database.js";
import { ReplayCache } from "../src/agy/db/replay.js";
import { conversationSnapshot, newConversationId } from "../src/agy/db/scan.js";
import { StreamPoller } from "../src/agy/db/streaming.js";
import { Translator } from "../src/agy/db/translator.js";
import { createConversationDb, insertStep, updateStep, updateStepPayload } from "./fixtures/conversation-db.js";
import {
  encodeAgentText,
  encodeCommandResult,
  encodeGrepSearchResult,
  encodePermissions,
  encodeSearchHit,
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

  it("decodes agent text thinking/reasoning (tag 3) from step type 15 payload", () => {
    const db = createConversationDb(dir, "conv-thought-step15");
    insertStep(db, {
      idx: 1,
      stepType: 15,
      stepPayload: encodeStepPayload({
        agentText: { text: "Result: 309524", thought: "Calculating 347 * 892..." }
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-thought-step15");
    expect(conn).not.toBeNull();
    const rows = conn!.readAfter(0);
    conn!.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].stepPayload.agentText?.text).toBe("Result: 309524");
    expect(rows[0].stepPayload.agentText?.thought).toBe("Calculating 347 * 892...");
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

  it("uses one message id for consecutive agent-text rows in streaming and replay", () => {
    const db = createConversationDb(dir, "conv-stream-message-group");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "Hello" }) });
    insertStep(db, { idx: 2, stepType: 15, stepPayload: encodeStepPayload({ agentText: "world" }) });
    db.close();

    const streamConn = ConversationDb.open(dir, "conv-stream-message-group")!;
    const streamUpdates = new Translator({ mode: "stream", skipNarration: false }).translate(
      streamConn.readAfter(-1)
    );
    streamConn.close();
    expect(streamUpdates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "Hello" }
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "\nworld" }
      }
    ]);

    const replayConn = ConversationDb.open(dir, "conv-stream-message-group")!;
    const replayUpdates = new Translator({ mode: "replay", skipNarration: false }).translate(
      replayConn.readAfter(-1)
    );
    replayConn.close();
    expect(replayUpdates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "Hello\nworld" },
        _meta: { stepIdx: 1, endStepIdx: 2 }
      }
    ]);
  });

  it("starts a streaming message group at the first row containing answer text", () => {
    const db = createConversationDb(dir, "conv-stream-thought-first");
    insertStep(db, {
      idx: 1,
      stepType: 15,
      stepPayload: encodeStepPayload({ agentText: { thought: "Thinking" } })
    });
    insertStep(db, {
      idx: 2,
      stepType: 15,
      stepPayload: encodeStepPayload({ agentText: "Answer" })
    });
    db.close();

    const streamConn = ConversationDb.open(dir, "conv-stream-thought-first")!;
    const streamUpdates = new Translator({ mode: "stream", skipNarration: false }).translate(
      streamConn.readAfter(-1)
    );
    streamConn.close();
    expect(streamUpdates).toContainEqual({
      sessionUpdate: "agent_message_chunk",
      messageId: "2",
      content: { type: "text", text: "Answer" }
    });

    const replayConn = ConversationDb.open(dir, "conv-stream-thought-first")!;
    const replayUpdates = new Translator({ mode: "replay", skipNarration: false }).translate(
      replayConn.readAfter(-1)
    );
    replayConn.close();
    expect(replayUpdates).toContainEqual({
      sessionUpdate: "agent_message_chunk",
      messageId: "2",
      content: { type: "text", text: "Answer" },
      _meta: { stepIdx: 2 }
    });
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

  it("maps active step status 1 to in_progress tool status", () => {
    const db = createConversationDb(dir, "conv-status-1");
    const call = encodeToolCall({ callId: "active-1", namePrimary: "run_command", rawInputJson: '{"CommandLine":"echo active"}' });
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 1, // active
      stepPayload: encodeStepPayload({ toolRun: encodeToolRun({ call }) })
    });
    const translator = new Translator({ mode: "stream", skipNarration: false });
    const conn = ConversationDb.open(dir, "conv-status-1")!;
    const res = translator.translate(conn.readAfter(0));
    expect(res).toMatchObject([
      {
        sessionUpdate: "tool_call",
        toolCallId: "active-1",
        status: "in_progress"
      }
    ]);
    conn.close();
    db.close();
  });

  it("maps permission-pending status 9 and dedupes its transition", () => {
    const db = createConversationDb(dir, "conv-pending");
    const payload = encodeStepPayload({ toolRun: encodeToolRun({ call: encodeToolCall({ callId: "p1", namePrimary: "run_command", rawInputJson: "{}" }) }) });
    insertStep(db, { idx: 1, stepType: 21, status: 9, stepPayload: payload });
    const translator = new Translator({ mode: "stream", skipNarration: false });
    const conn = ConversationDb.open(dir, "conv-pending")!;
    expect(translator.translate(conn.readAfter(0))).toMatchObject([{ sessionUpdate: "tool_call", status: "pending" }]);
    expect(translator.translate(conn.readAfter(0))).toEqual([]);
    updateStep(db, 1, { status: 3, stepPayload: payload });
    expect(translator.translate(conn.readAfter(0))).toMatchObject([{ sessionUpdate: "tool_call_update", status: "completed" }]);
    conn.close(); db.close();
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
      { sessionUpdate: "session_info_update", title: "My session", _meta: { stepIdx: 1 } },
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "title-thought-1",
        content: { type: "text", text: "I will inspect the repo structure first." },
        _meta: { stepIdx: 1 }
      }
    ]);

    // Second poll: no duplicate thought/title.
    const conn2 = ConversationDb.open(dir, "conv-thought")!;
    expect(translator.translate(conn2.readAfter(0))).toHaveLength(0);
    conn2.close();
  });

  it("emits agent_thought_chunk for step type 15 carrying thought payload in streaming and replay modes", () => {
    const db = createConversationDb(dir, "conv-agent-thought-stream");
    insertStep(db, {
      idx: 1,
      stepType: 15,
      stepPayload: encodeStepPayload({
        agentText: { text: "Final output", thought: "Thinking deeply..." }
      })
    });
    db.close();

    // Stream mode
    const connStream = ConversationDb.open(dir, "conv-agent-thought-stream")!;
    const streamTranslator = new Translator({ mode: "stream", skipNarration: false });
    const streamUpdates = streamTranslator.translate(connStream.readAfter(0));
    connStream.close();

    expect(streamUpdates).toEqual([
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "agent-thought-1",
        content: { type: "text", text: "Thinking deeply..." },
        _meta: { stepIdx: 1 }
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "Final output" }
      }
    ]);

    // Replay mode
    const connReplay = ConversationDb.open(dir, "conv-agent-thought-stream")!;
    const replayTranslator = new Translator({ mode: "replay", skipNarration: false });
    const replayUpdates = replayTranslator.translate(connReplay.readAfter(-1));
    connReplay.close();

    expect(replayUpdates).toEqual([
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "agent-thought-1",
        content: { type: "text", text: "Thinking deeply..." },
        _meta: { stepIdx: 1 }
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "Final output" },
        _meta: { stepIdx: 1 }
      }
    ]);
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
    expect(update.rawOutput).toMatchObject({ exitCode: 0 });
    const body = (update.content ?? []).map((c) => c.content?.text ?? "").join("\n");
    expect(body).toContain("README.md");
  });

  it("does not emit directory Cwd in locations for run_command steps (regression for issue #16)", () => {
    const db = createConversationDb(dir, "conv-exec-no-dir-location");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "c-dir",
            namePrimary: "run_command",
            rawInputJson: JSON.stringify({ CommandLine: "ls", Cwd: dir })
          })
        }),
        commandResult: encodeCommandResult({
          cwd: dir,
          exitCode: 0,
          output: "ok\n",
          command: "ls"
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-exec-no-dir-location")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as { locations?: unknown[] };
    expect(update.locations).toBeUndefined();
  });

  it("does not emit directory path in locations for list_dir steps", () => {
    const db = createConversationDb(dir, "conv-list-dir-no-location");
    insertStep(db, {
      idx: 1,
      stepType: 9,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "l-dir",
            namePrimary: "list_dir",
            rawInputJson: JSON.stringify({ DirectoryPath: dir })
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-list-dir-no-location")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as { locations?: unknown[] };
    expect(update.locations).toBeUndefined();
  });

  it("does not emit directory SearchPath in locations for grep_search steps", () => {
    const db = createConversationDb(dir, "conv-grep-dir-no-location");
    insertStep(db, {
      idx: 1,
      stepType: 7,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "g-dir",
            namePrimary: "grep_search",
            rawInputJson: JSON.stringify({ Query: "foo", SearchPath: dir })
          })
        }),
        grepSearch: encodeGrepSearchResult({
          query: "foo",
          cwdUri: `file://${dir}`
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-grep-dir-no-location")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as { locations?: unknown[] };
    expect(update.locations).toBeUndefined();
  });

  it("does not emit non-existent or deleted SearchPath in locations for grep_search steps", () => {
    const deletedDir = path.join(dir, "non-existent-folder");
    const db = createConversationDb(dir, "conv-grep-deleted-dir");
    insertStep(db, {
      idx: 1,
      stepType: 7,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "g-deleted",
            namePrimary: "grep_search",
            rawInputJson: JSON.stringify({ Query: "foo", SearchPath: deletedDir })
          })
        }),
        grepSearch: encodeGrepSearchResult({
          query: "foo",
          cwdUri: `file://${deletedDir}`
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-grep-deleted-dir")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as { locations?: unknown[] };
    expect(update.locations).toBeUndefined();
  });

  it("emits SearchPath in locations for grep_search steps when SearchPath is a file", () => {
    const file = path.join(dir, "test.txt");
    fs.writeFileSync(file, "hello world");
    const db = createConversationDb(dir, "conv-grep-file");
    insertStep(db, {
      idx: 1,
      stepType: 7,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "g-file",
            namePrimary: "grep_search",
            rawInputJson: JSON.stringify({ Query: "hello", SearchPath: file })
          })
        }),
        grepSearch: encodeGrepSearchResult({
          query: "hello",
          cwdUri: `file://${file}`
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-grep-file")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as { locations?: Array<{ path: string }> };
    expect(update.locations).toEqual([{ path: file }]);
  });

  it("resolves relative SearchPath against session cwd for grep_search steps", () => {
    const relFile = "subfolder/rel-file.txt";
    const absFolder = path.join(dir, "subfolder");
    fs.mkdirSync(absFolder, { recursive: true });
    const absFile = path.join(dir, relFile);
    fs.writeFileSync(absFile, "relative content");

    const db = createConversationDb(dir, "conv-grep-rel");
    insertStep(db, {
      idx: 1,
      stepType: 7,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "g-rel",
            namePrimary: "grep_search",
            rawInputJson: JSON.stringify({ Query: "relative", SearchPath: relFile })
          })
        }),
        grepSearch: encodeGrepSearchResult({
          query: "relative"
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-grep-rel")!;
    const translator = new Translator({ mode: "replay", skipNarration: false, cwd: dir });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as { locations?: Array<{ path: string }> };
    expect(update.locations).toEqual([{ path: absFile }]);
  });

  it("does not emit location for replayed view_file step when file does not exist on disk", () => {
    const missingFile = path.join(dir, "non-existent-view.txt");
    const db = createConversationDb(dir, "conv-view-missing");
    insertStep(db, {
      idx: 1,
      stepType: 8,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "view-missing",
            namePrimary: "view_file",
            rawInputJson: JSON.stringify({ AbsolutePath: missingFile })
          })
        }),
        viewFile: encodeViewFileResult({
          fileUri: `file://${missingFile}`,
          content: "cached historical content\n"
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-view-missing")!;
    const translator = new Translator({ mode: "replay", skipNarration: false, cwd: dir });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as { locations?: unknown[] };
    expect(update.locations).toBeUndefined();
  });

  it("uses resolved session path for view_file cache keys on full-file writes with relative paths", () => {
    const db = createConversationDb(dir, "conv-write-diff-rel");
    insertStep(db, {
      idx: 1,
      stepType: 8,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "read-rel",
            namePrimary: "view_file",
            rawInputJson: '{"AbsolutePath":"a.ts"}'
          })
        }),
        viewFile: encodeViewFileResult({
          fileUri: "a.ts",
          content: "export const x = 1;\n"
        })
      })
    });
    insertStep(db, {
      idx: 2,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "write-rel",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({
              TargetFile: "a.ts",
              CodeContent: "export const x = 2;\n"
            })
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-write-diff-rel")!;
    const translator = new Translator({ mode: "replay", skipNarration: false, cwd: dir });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    const write = updates.find(
      (u) => (u as { toolCallId?: string }).toolCallId === "write-rel"
    ) as {
      content?: Array<{ type?: string; path?: string; oldText?: string | null; newText?: string }>;
    };
    expect(write).toBeTruthy();
    const diff = (write.content ?? []).find((c) => c.type === "diff");
    expect(diff).toMatchObject({
      type: "diff",
      oldText: "export const x = 1;\n",
      newText: "export const x = 2;\n"
    });
  });

  it("does not attach exitCode in rawOutput for pending run_command steps", () => {
    const db = createConversationDb(dir, "conv-exec-pending");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 9,
      stepPayload: encodeStepPayload({
        commandResult: encodeCommandResult({
          command: "gh issue view",
          cwd: "/path/to/cwd",
          exitCode: 0
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-exec-pending")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as {
      sessionUpdate: string;
      kind: string;
      status: string;
      rawOutput?: { exitCode?: number };
    };
    expect(update.sessionUpdate).toBe("tool_call");
    expect(update.kind).toBe("execute");
    expect(update.status).toBe("pending");
    expect(update.rawOutput).toBeUndefined();
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

  it("decodes grep_search hits whose field 2 is a varint line number (regression for issue #12)", () => {
    const db = createConversationDb(dir, "conv-grep");
    insertStep(db, {
      idx: 1,
      stepType: 7,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "g-1",
            namePrimary: "grep_search",
            rawInputJson: '{"Query":"Unreleased","SearchPath":"/repo"}'
          })
        }),
        grepSearch: encodeGrepSearchResult({
          query: "Unreleased",
          cwdUri: "file:///repo",
          hits: [
            encodeSearchHit({ field1: "CHANGELOG.md", field2: 9, field3: "## [Unreleased]", field4: "/repo/CHANGELOG.md" }),
            encodeSearchHit({ field1: "CHANGELOG.md", field2: 42, field3: "## [Unreleased] - 2026-01-01", field4: "/repo/CHANGELOG.md" })
          ]
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-grep")!;
    const rows = conn.readAfter(-1);
    conn.close();

    // The whole point of the regression: this must not throw "premature EOF"
    // / "cant skip wire type 6/7", and the hits must carry line numbers.
    expect(rows).toHaveLength(1);
    const hits = rows[0].stepPayload.grepSearch?.hits ?? [];
    expect(hits).toHaveLength(2);
    expect(hits[0].field1).toBe("CHANGELOG.md");
    expect(hits[0].field2).toBe(9);
    expect(hits[0].field3).toBe("## [Unreleased]");
    expect(hits[0].field4).toBe("/repo/CHANGELOG.md");
    expect(hits[1].field2).toBe(42);

    const translator = new Translator({ mode: "replay", skipNarration: false });
    const conn2 = ConversationDb.open(dir, "conv-grep")!;
    const updates = translator.translate(conn2.readAfter(-1));
    conn2.close();
    expect(updates).toHaveLength(1);
    const update = updates[0] as { kind: string; content?: Array<{ content?: { text?: string } }> };
    expect(update.kind).toBe("search");
    const body = (update.content ?? []).map((c) => c.content?.text ?? "").join("\n");
    expect(body).toContain("CHANGELOG.md | 9 | ## [Unreleased]");
    expect(body).toContain("CHANGELOG.md | 42 | ## [Unreleased] - 2026-01-01");
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
    expect(update.title).toBe("Fetch Example Doc");
    expect(update.rawOutput).toMatchObject({ title: "Example Doc" });
    const body = (update.content ?? []).map((c) => c.content?.text ?? "").join("\n");
    expect(body).toContain("https://example.com/doc");
    expect(body).toContain("Body from the page.");
  });

  it("uses prior view_file content as oldText on full-file writes", () => {
    const db = createConversationDb(dir, "conv-write-diff");
    insertStep(db, {
      idx: 1,
      stepType: 8,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "read-1",
            namePrimary: "view_file",
            rawInputJson: '{"AbsolutePath":"/repo/a.ts"}'
          })
        }),
        viewFile: encodeViewFileResult({
          fileUri: "file:///repo/a.ts",
          content: "export const x = 1;\n"
        })
      })
    });
    insertStep(db, {
      idx: 2,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "write-1",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({
              TargetFile: "/repo/a.ts",
              CodeContent: "export const x = 2;\n"
            })
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-write-diff")!;
    const translator = new Translator({ mode: "replay", skipNarration: false, cwd: "/repo" });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    const write = updates.find(
      (u) => (u as { toolCallId?: string }).toolCallId === "write-1"
    ) as {
      content?: Array<{ type?: string; path?: string; oldText?: string | null; newText?: string }>;
    };
    expect(write).toBeTruthy();
    const diff = (write.content ?? []).find((c) => c.type === "diff");
    expect(diff).toMatchObject({
      type: "diff",
      path: "/repo/a.ts",
      oldText: "export const x = 1;\n",
      newText: "export const x = 2;\n"
    });
  });

  it("does not use ranged view_file slices as oldText for full-file writes", () => {
    const db = createConversationDb(dir, "conv-write-ranged");
    insertStep(db, {
      idx: 1,
      stepType: 8,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "read-range",
            namePrimary: "view_file",
            rawInputJson: '{"AbsolutePath":"/repo/a.ts","StartLine":10,"EndLine":20}'
          })
        }),
        viewFile: encodeViewFileResult({
          fileUri: "file:///repo/a.ts",
          startLine: 10,
          endLine: 20,
          content: "partial slice\n"
        })
      })
    });
    insertStep(db, {
      idx: 2,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "write-2",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({
              TargetFile: "/repo/a.ts",
              CodeContent: "full file\n"
            })
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-write-ranged")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    const write = updates.find(
      (u) => (u as { toolCallId?: string }).toolCallId === "write-2"
    ) as {
      content?: Array<{ type?: string; oldText?: string | null; newText?: string }>;
    };
    const diff = (write.content ?? []).find((c) => c.type === "diff");
    expect(diff).toMatchObject({ oldText: null, newText: "full file\n" });
  });

  it("labels permission decisions as granted or denied", () => {
    const db = createConversationDb(dir, "conv-perm");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 7,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "cmd-deny",
            namePrimary: "run_command",
            rawInputJson: '{"CommandLine":"rm -rf /"}'
          })
        })
      }),
      permissions: encodePermissions({ kind: "command", value: "rm -rf /", decision: 0 })
    });
    insertStep(db, {
      idx: 2,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "cmd-ok",
            namePrimary: "run_command",
            rawInputJson: '{"CommandLine":"ls"}'
          })
        })
      }),
      permissions: encodePermissions({ kind: "unsandboxed", value: "ls", decision: 1 })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-perm")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(2);
    const texts = updates.map((u) =>
      ((u as { content?: Array<{ content?: { text?: string } }> }).content ?? [])
        .map((c) => c.content?.text ?? "")
        .join("\n")
    );
    expect(texts[0]).toContain("Permission denied: command (rm -rf /)");
    expect(texts[1]).toContain("Permission granted: unsandboxed (ls)");
  });

  it("presents brain plan writes as structured ACP plan entries", () => {
    const planPath =
      "/Users/me/.gemini/antigravity-cli/brain/abc/.system_generated/steps/1/implementation_plan.md";
    const db = createConversationDb(dir, "conv-plan");
    insertStep(db, {
      idx: 1,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "plan-1",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({
              TargetFile: planPath,
              CodeContent: "# Plan\n\n1. Do the thing\n2. Ship it\n"
            })
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-plan")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as {
      sessionUpdate: string;
      entries?: Array<{ content: string; status: string; priority: string }>;
    };
    expect(update.sessionUpdate).toBe("plan");
    expect(update.entries?.map((e) => e.content)).toEqual(["Do the thing", "Ship it"]);
    expect(update.entries?.every((e) => e.status === "pending")).toBe(true);
  });

  it("dedups unchanged plan snapshots across stream polls", () => {
    const planPath =
      "/Users/me/.gemini/antigravity-cli/brain/abc/.system_generated/steps/1/implementation_plan.md";
    const db = createConversationDb(dir, "conv-plan-dedup");
    insertStep(db, {
      idx: 1,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "plan-1",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({
              TargetFile: planPath,
              CodeContent: "- [ ] One\n- [x] Two\n"
            })
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-plan-dedup")!;
    const translator = new Translator({ mode: "stream", skipNarration: false });
    const first = translator.translate(conn.readAfter(-1));
    const second = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    const entries = (first[0] as { entries: Array<{ content: string; status: string }> }).entries;
    expect(entries).toEqual([
      { content: "One", priority: "high", status: "pending" },
      { content: "Two", priority: "high", status: "completed" }
    ]);
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
        content: { type: "text", text: "Hello\n world" },
        _meta: { stepIdx: 1, endStepIdx: 2 }
      }
    ]);
  });

  it("stamps _meta.stepIdx on title, thought, and agent text updates", () => {
    const db = createConversationDb(dir, "conv-stamped");
    insertStep(db, { idx: 10, stepType: 23, stepPayload: encodeStepPayload({ titleUpdate: "My Title\n\nTitle narration" }) });
    insertStep(db, { idx: 11, stepType: 15, stepPayload: encodeStepPayload({ agentText: { text: "Done", thought: "Thinking..." } }) });
    db.close();

    const conn = ConversationDb.open(dir, "conv-stamped")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toEqual([
      {
        sessionUpdate: "session_info_update",
        title: "My Title",
        _meta: { stepIdx: 10 }
      },
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "title-thought-10",
        content: { type: "text", text: "Title narration" },
        _meta: { stepIdx: 10 }
      },
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "agent-thought-11",
        content: { type: "text", text: "Thinking..." },
        _meta: { stepIdx: 11 }
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "11",
        content: { type: "text", text: "Done" },
        _meta: { stepIdx: 11 }
      }
    ]);
  });
});

describe("StreamPoller", () => {
  it("skips decoding unchanged databases and still detects in-place payload growth", () => {
    const db = createConversationDb(dir, "conv-poll");
    insertStep(db, {
      idx: 1,
      stepType: 15,
      stepPayload: encodeStepPayload({ agentText: "Hello" })
    });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-poll",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    expect(poller.poll()).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "Hello" }
      }
    ]);
    const revision = poller.revision;
    const readSpy = vi.spyOn(ConversationDb.prototype, "readAfter");
    expect(poller.poll()).toEqual([]);
    expect(readSpy).not.toHaveBeenCalled();
    expect(poller.revision).toBe(revision);

    updateStepPayload(db, 1, encodeStepPayload({ agentText: "Hello world" }));
    expect(poller.poll()).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: " world" }
      }
    ]);
    expect(readSpy).toHaveBeenCalledOnce();
    expect(poller.revision).toBe(revision + 1);

    readSpy.mockRestore();
    poller.close();
    db.close();
  });

  it("increments revision for auxiliary-column-only mutations", () => {
    const db = createConversationDb(dir, "conv-poll-permission");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "cmd-1",
            namePrimary: "run_command",
            rawInputJson: '{"CommandLine":"ls"}'
          })
        })
      })
    });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-poll-permission",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    expect(poller.poll()).toHaveLength(1);
    const revision = poller.revision;
    db.prepare("UPDATE steps SET permissions = ? WHERE idx = 1").run(
      Buffer.from(encodePermissions({ kind: "command", value: "ls", decision: 1 }))
    );
    const updated = poller.poll();
    expect(updated).toHaveLength(1);
    expect((updated[0] as { sessionUpdate: string }).sessionUpdate).toBe("tool_call_update");
    expect(poller.revision).toBe(revision + 1);
    expect(poller.poll()).toEqual([]);

    poller.close();
    db.close();
  });

  it("queues a new pending interaction when an identical status-9 gate is re-armed", () => {
    const db = createConversationDb(dir, "conv-identical-gate");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 9,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "cmd-identical",
            namePrimary: "run_command",
            rawInputJson: '{"CommandLine":"echo x && echo x"}'
          })
        })
      })
    });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-identical-gate",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    expect(poller.poll()).toHaveLength(1);
    expect(poller.takePending()).toHaveLength(1);

    const permission = Buffer.from(encodePermissions({ kind: "command", value: "echo x", decision: 1 }));
    db.prepare("UPDATE steps SET permissions = ? WHERE idx = 1").run(permission);
    expect(poller.poll()).toHaveLength(1);
    expect(poller.takePending()).toHaveLength(1);

    // SQLite does not advance data_version when the exact same bytes are
    // written, so the poll itself has no occurrence to report.
    db.prepare("UPDATE steps SET permissions = ? WHERE idx = 1").run(permission);
    expect(poller.poll()).toEqual([]);
    expect(poller.takePending()).toEqual([]);

    // The TUI redraw supplies the generation in this case. Requeueing remains
    // deduplicated until the queued occurrence is consumed.
    poller.requeuePending("cmd-identical");
    poller.requeuePending("cmd-identical");
    expect(poller.takePending()).toHaveLength(1);

    poller.close();
    db.close();
  });

  it("retries readAfter on next poll if a torn read decode error occurs", () => {
    const db = createConversationDb(dir, "conv-torn-read");
    // Insert step with invalid/corrupt blob payload to simulate premature EOF
    db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)").run(
      1, 21, 9, Buffer.from([0x08, 0xff])
    );
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-torn-read",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    // First poll encounters decode error, so dataVersion is NOT cached
    expect(poller.poll()).toEqual([]);

    // Now update row 1 to hold a valid payload (simulating completed write)
    db.prepare("UPDATE steps SET step_payload = ? WHERE idx = 1").run(
      Buffer.from(encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "cmd-1",
            namePrimary: "run_command",
            rawInputJson: '{"CommandLine":"ls"}'
          })
        })
      }))
    );

    // Second poll retries reading and successfully decodes the step
    const updates = poller.poll();
    expect(updates).toHaveLength(1);
    expect((updates[0] as { sessionUpdate: string }).sessionUpdate).toBe("tool_call");

    poller.close();
    db.close();
  });

  it("bounds retries on a permanently undecodable row after 3 failed attempts on the same dataVersion", () => {
    const db = createConversationDb(dir, "conv-perm-corrupt");
    // Insert step with invalid/corrupt blob payload to simulate permanently corrupted data
    db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)").run(
      1, 21, 9, Buffer.from([0x08, 0xff])
    );
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-perm-corrupt",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    // Poll 1: encounters decode error (attempt 1), returns []
    expect(poller.poll()).toEqual([]);
    // Poll 2: encounters decode error (attempt 2), returns []
    expect(poller.poll()).toEqual([]);
    // Poll 3: encounters decode error (attempt 3), caches dataVersion and returns []
    expect(poller.poll()).toEqual([]);

    // Poll 4: because dataVersion is now cached, poll() immediately returns [] without re-reading/re-logging
    expect(poller.poll()).toEqual([]);

    poller.close();
    db.close();
  });

  it("does not complete from a terminal row when a trailing row failed to decode", () => {
    const db = createConversationDb(dir, "conv-terminal-before-corrupt");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({ callId: "cmd-1", namePrimary: "run_command", rawInputJson: "{}" })
        })
      })
    });
    db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)").run(
      2, 15, 3, Buffer.from([0x0a, 0xff])
    );
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-terminal-before-corrupt",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    // The surviving terminal tool must not hide the undecodable final row,
    // including after retries for this data version have been bounded.
    expect(poller.poll()).toHaveLength(1);
    expect(poller.turnCompleteCandidate).toBe(false);
    expect(poller.poll()).toEqual([]);
    expect(poller.turnCompleteCandidate).toBe(false);
    expect(poller.poll()).toEqual([]);
    expect(poller.turnCompleteCandidate).toBe(false);
    expect(poller.poll()).toEqual([]);
    expect(poller.turnCompleteCandidate).toBe(false);

    db.prepare("UPDATE steps SET step_payload = ? WHERE idx = 2").run(
      Buffer.from(encodeStepPayload({ agentText: "done" }))
    );
    expect(poller.poll()).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "2",
        content: { type: "text", text: "done" }
      }
    ]);
    expect(poller.turnCompleteCandidate).toBe(true);

    poller.close();
    db.close();
  });
});

describe("ReplayCache", () => {
  it("serves unchanged cache hits and rebuilds grouped messages after growth", () => {
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
    expect(grown?.updates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "Hello\n world" },
        _meta: { stepIdx: 1, endStepIdx: 2 }
      }
    ]);
    expect(grown?.maxIdx).toBe(2);
  });

  it("rebuilds cached replay after an in-place step update", () => {
    const db = createConversationDb(dir, "conv-replay-mutation");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "partial" }) });

    const cache = new ReplayCache(8);
    expect(cache.get(dir, "conv-replay-mutation", { skipNarration: false })?.updates).toMatchObject([
      { content: { text: "partial" } }
    ]);

    updateStepPayload(db, 1, encodeStepPayload({ agentText: "complete result" }));
    db.close();

    expect(cache.get(dir, "conv-replay-mutation", { skipNarration: false })?.updates).toMatchObject([
      { content: { text: "complete result" } }
    ]);
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
