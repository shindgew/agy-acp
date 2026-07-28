import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import * as installer from "../src/agy/installer.js";
import {
  AgyCliBackend,
  AgyCliSession,
  DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS,
  DEFAULT_CONVERSATIONS_DIR,
  configFromEnv,
  parseAgyModels,
  type AgyCliConfig,
  type PtyFactory,
  type PtyProcess,
  type SpawnFactory,
  type SpawnOptions
} from "../src/agy/cli.js";
import {
  canBridgeInteraction,
  interactionKeys,
  isBridgeablePermissionTool,
  permissionKeys,
  permissionOptions
} from "../src/acp/tool-calls/permissions.js";
import { createConversationDb, insertStep, updateStep } from "./fixtures/conversation-db.js";
import { encodePermissions, encodeStepPayload, encodeToolCall, encodeToolRun } from "./fixtures/step-encoder.js";

/** Collects updates via the `onUpdate` callback `AgyCliSession.prompt` takes. */
async function collectUpdates(
  session: AgyCliSession,
  prompt: string
): Promise<{ updates: SessionUpdate[]; stopReason: "end_turn" | "cancelled" }> {
  const updates: SessionUpdate[] = [];
  const outcome = await session.prompt(prompt, async (update) => {
    updates.push(update);
  });
  return { updates, stopReason: outcome.stopReason };
}

describe("commandForPrompt", () => {
  it("uses agy print mode and safe defaults", () => {
    const session = new AgyCliSession({
      ...defaultConfig(),
      additionalDirectories: ["/extra"],
      agyPath: "/opt/homebrew/bin/agy",
      model: "gemini-test",
      project: "project-1",
      printTimeout: "30s",
      logFile: "/tmp/agy.log"
    });

    const command = session.commandForPrompt("hello");

    expect(command[0]).toBe("/opt/homebrew/bin/agy");
    expect(command).toContain("--print");
    expect(command[command.indexOf("--print") + 1]).toBe("hello");
    expect(command).toContain("--sandbox");
    expect(flagValue(command, "--model")).toBe("gemini-test");
    expect(command).not.toContain("--effort");
    expect(flagValue(command, "--project")).toBe("project-1");
    // cwd + additionalDirectories as --add-dir roots
    expect(command.filter((_, i) => command[i - 1] === "--add-dir")).toEqual(["/repo", "/extra"]);
  });

  it("includes --effort when configured", () => {
    const session = new AgyCliSession({
      ...defaultConfig(),
      model: "gemini-3.5-flash",
      effort: "high"
    });
    const command = session.commandForPrompt("hello");
    expect(flagValue(command, "--model")).toBe("gemini-3.5-flash");
    expect(flagValue(command, "--effort")).toBe("high");
  });

  it("omits --mode for default and passes accept-edits or plan", () => {
    const defaultCmd = new AgyCliSession(defaultConfig()).commandForPrompt("hello");
    expect(defaultCmd).not.toContain("--mode");

    const acceptCmd = new AgyCliSession({
      ...defaultConfig(),
      mode: "accept-edits"
    }).commandForPrompt("hello");
    expect(flagValue(acceptCmd, "--mode")).toBe("accept-edits");

    const planCmd = new AgyCliSession({
      ...defaultConfig(),
      mode: "plan"
    }).commandForPrompt("hello");
    expect(flagValue(planCmd, "--mode")).toBe("plan");
  });

  it("builds interactive mode without print flags", () => {
    const session = new AgyCliSession({ ...defaultConfig(), interactivePermissions: true });
    const command = session.interactiveCommandForPrompt("hello");
    expect(command.slice(0, 3)).toEqual(["agy", "--prompt-interactive", "hello"]);
    expect(command).not.toContain("--print");
    expect(command).not.toContain("--print-timeout");
  });
});

describe("permission bridge", () => {
  it("maps every semantic choice to agy's menu keys", () => {
    expect(permissionKeys("agy-allow-once")).toBe("\r");
    expect(permissionKeys("agy-allow-conversation")).toBe("\x1b[B\r");
    expect(permissionKeys("agy-allow-settings")).toBe("\x1b[B\x1b[B\r");
    expect(permissionKeys("agy-reject-once")).toBe("\x1b[B\x1b[B\x1b[B\r");
    expect(permissionOptions({ sessionUpdate: "tool_call", toolCallId: "x", title: "Run", kind: "execute", status: "pending", rawInput: { CommandLine: "whoami" } })).toEqual([
      { optionId: "agy-allow-once", kind: "allow_once", name: "Yes" },
      { optionId: "agy-allow-conversation", kind: "allow_always", name: "Yes, and always allow in this conversation for commands that start with 'whoami'" },
      { optionId: "agy-allow-settings", kind: "allow_always", name: "Yes, and always allow for commands that start with 'whoami' (Persist to settings.json)" },
      { optionId: "agy-reject-once", kind: "reject_once", name: "No" }
    ]);
    expect(permissionOptions({
      sessionUpdate: "tool_call",
      toolCallId: "y",
      title: "Edit src/cli.ts",
      kind: "edit",
      status: "pending",
      rawInput: { TargetFile: "/repo/src/cli.ts" }
    }, "replace_file_content")).toEqual([
      { optionId: "allow-once", kind: "allow_once", name: "Allow" },
      { optionId: "allow-always", kind: "allow_always", name: "Always allow" },
      { optionId: "reject-once", kind: "reject_once", name: "Reject" }
    ]);
    expect(interactionKeys("allow-once", "replace_file_content")).toBe("\r");
    expect(interactionKeys("reject-once", "replace_file_content")).toBe("\x1b[B\x1b[B\x1b[B\r");
    expect(isBridgeablePermissionTool("run_command")).toBe(true);
    expect(isBridgeablePermissionTool("replace_file_content")).toBe(true);
    expect(isBridgeablePermissionTool("write_to_file")).toBe(true);
    expect(isBridgeablePermissionTool("view_file")).toBe(true);
    expect(isBridgeablePermissionTool("ask_question")).toBe(false);

    const askCall = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "q1",
      title: "Pick one",
      kind: "other" as const,
      status: "pending" as const,
      rawInput: {
        questions: [{
          question: "Which approach?",
          options: ["Option A", "Option B", "Option C"],
          is_multi_select: false
        }]
      }
    };
    expect(canBridgeInteraction("ask_question", askCall)).toBe(true);
    expect(permissionOptions(askCall, "ask_question")).toEqual([
      { optionId: "agy-q-0", kind: "allow_once", name: "Option A" },
      { optionId: "agy-q-1", kind: "allow_once", name: "Option B" },
      { optionId: "agy-q-2", kind: "allow_once", name: "Option C" },
      { optionId: "agy-q-skip", kind: "reject_once", name: "Skip" }
    ]);
    expect(interactionKeys("agy-q-0", "ask_question", askCall)).toBe("\r");
    expect(interactionKeys("agy-q-1", "ask_question", askCall)).toBe("\x1b[B\r");
    expect(interactionKeys("agy-q-2", "ask_question", askCall)).toBe("\x1b[B\x1b[B\r");
    expect(interactionKeys("agy-q-skip", "ask_question", askCall)).toBe("\x1b");
  });

  it("bridges agy's ask_permission sandbox-bypass request as a command-style menu", () => {
    // agy 1.1.7 gates sandbox bypass (run a command / read a file outside the
    // sandbox) through a status-9 `ask_permission` step whose TUI menu is the
    // same 4-row layout as run_command. It must be bridged, not thrown on.
    const askPermission = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "ap1",
      title: "Permission request for git directory",
      kind: "other" as const,
      status: "pending" as const,
      rawInput: {
        Action: "read_file",
        Reason: "To allow git inside the sandbox to read the parent repository",
        Target: "/repo/.git",
        toolAction: "Requesting read access to the git parent repository"
      }
    };
    expect(isBridgeablePermissionTool("ask_permission")).toBe(true);
    expect(canBridgeInteraction("ask_permission", askPermission)).toBe(true);
    expect(permissionOptions(askPermission, "ask_permission")).toEqual([
      { optionId: "agy-allow-once", kind: "allow_once", name: "Yes" },
      { optionId: "agy-allow-conversation", kind: "allow_always", name: "Yes, and always allow '/repo/.git' in this conversation" },
      { optionId: "agy-allow-settings", kind: "allow_always", name: "Yes, and always allow '/repo/.git' (Persist to settings.json)" },
      { optionId: "agy-reject-once", kind: "reject_once", name: "No" }
    ]);
    expect(interactionKeys("agy-allow-once", "ask_permission", askPermission)).toBe("\r");
    expect(interactionKeys("agy-reject-once", "ask_permission", askPermission)).toBe("\x1b[B\x1b[B\x1b[B\r");
  });

  for (const [choice, keys] of [
    ["agy-allow-once", "\r"],
    ["agy-allow-conversation", "\x1b[B\r"],
    ["agy-allow-settings", "\x1b[B\x1b[B\r"],
    ["agy-reject-once", "\x1b[B\x1b[B\x1b[B\r"]
  ] as const) {
    it(`bridges ${choice} once and waits for the post-final idle marker`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
      const pty = new FakePty(() => {
        const db = createConversationDb(dir, "permission");
        insertStep(db, pendingToolRow("run_command"));
        db.close();
      });
      const session = interactiveSession(dir, pty);
      let calls = 0;
      let resolved = false;
      const result = session.prompt("go", async () => {}, async () => {
        calls++;
        const db = new (await import("better-sqlite3")).default(path.join(dir, "permission.db"));
        updateStep(db, 1, { status: 3 });
        insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
        db.close();
        setTimeout(() => pty.emitData("? for shortcuts"), 250);
        return choice;
      }).then((value) => { resolved = true; return value; });
      await new Promise((resolve) => setTimeout(resolve, 225));
      expect(resolved).toBe(false);
      expect((await result).stopReason).toBe("end_turn");
      expect(calls).toBe(1);
      expect(pty.writes).toEqual(permissionWriteChunks(keys));
      await session.close();
      expect(pty.killed).toBe(true);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  it("completes a turn that ends on a denied command (failed tool step, no trailing message)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "denied");
      insertStep(db, pendingToolRow("run_command", '{"CommandLine":"git reset"}'));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const result = session.prompt("go", async () => {}, async () => {
      // agy records the denial and fails the command; the turn ends here with
      // NO trailing agent-text step (matches real denied-command turns).
      const db = new (await import("better-sqlite3")).default(path.join(dir, "denied.db"));
      updateStep(db, 1, { status: 7 });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 150);
      return "agy-reject-once";
    });
    expect((await result).stopReason).toBe("end_turn");
    expect(pty.writes).toEqual(["\x1b[B", "\x1b[B", "\x1b[B", "\r"]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preserves permission panel visibility when intervening non-marker PTY data arrives before applying permission response", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "permission-intervening-pty");
      insertStep(db, pendingToolRow("run_command"));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const result = session.prompt("go", async () => {}, async () => {
      // Simulate stray terminal output / ANSI codes arriving while user is reviewing prompt
      pty.emitData("\x1b[?25hstray output");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const db = new (await import("better-sqlite3")).default(path.join(dir, "permission-intervening-pty.db"));
      updateStep(db, 1, { status: 3 });
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 100);
      return "agy-allow-once";
    });

    expect((await result).stopReason).toBe("end_turn");
    expect(pty.writes).toEqual(["\r"]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts an idle marker emitted after the DB write but before the next poll", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "permission-race");
      insertStep(db, pendingToolRow("run_command"));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const result = session.prompt("go", async () => {}, async () => {
      const db = new (await import("better-sqlite3")).default(path.join(dir, "permission-race.db"));
      updateStep(db, 1, { status: 3 });
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 0);
      return "agy-allow-once";
    });

    expect((await result).stopReason).toBe("end_turn");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not mistake the fresh TUI startup marker for turn completion", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "startup-marker");
      insertStep(db, { idx: 1, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
    });
    const session = interactiveSession(dir, pty);
    let resolved = false;
    const result = session.prompt("go", async () => {}, async () => "agy-allow-once")
      .then((value) => { resolved = true; return value; });

    await new Promise((resolve) => setTimeout(resolve, 225));
    pty.emitData("redraw without another marker");
    await new Promise((resolve) => setTimeout(resolve, 225));
    expect(resolved).toBe(false);
    pty.emitData("? for shortcuts");
    expect((await result).stopReason).toBe("end_turn");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pauses turn deadline while waiting for ACP client permission response and extends turn timeout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "permission-timeout");
      insertStep(db, pendingToolRow("run_command"));
      db.close();
    });
    const session = interactiveSession(dir, pty, "2s");

    const result = session.prompt("go", async () => {}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const db = new (await import("better-sqlite3")).default(path.join(dir, "permission-timeout.db"));
      updateStep(db, 1, { status: 3 });
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 450);
      return "agy-allow-once";
    });

    expect((await result).stopReason).toBe("end_turn");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("re-arms turn deadline to full printTimeout after permission prompt resolves", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "permission-rearm");
      insertStep(db, pendingToolRow("run_command"));
      db.close();
    });
    // Set a short printTimeout of 300ms
    const session = interactiveSession(dir, pty, "300ms");

    const result = session.prompt("go", async () => {}, async () => {
      // User takes 150ms to answer permission prompt
      await new Promise((resolve) => setTimeout(resolve, 150));
      // After permission resolves, agy executes command which completes 250ms later (total 400ms wall clock)
      setTimeout(async () => {
        const { default: Database } = await import("better-sqlite3");
        const db = new Database(path.join(dir, "permission-rearm.db"));
        updateStep(db, 1, { status: 3 });
        insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
        db.close();
        pty.emitData("? for shortcuts");
      }, 250);
      return "agy-allow-once";
    });

    expect((await result).stopReason).toBe("end_turn");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("re-forwards a re-armed status-9 prompt on the same run_command step (compound `a && b`)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "compound");
      insertStep(db, pendingToolRow("run_command", '{"CommandLine":"git status && git log"}'));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    let calls = 0;
    const result = session.prompt("go", async () => {}, async () => {
      calls++;
      const { default: Database } = await import("better-sqlite3");
      const db = new Database(path.join(dir, "compound.db"));
      if (calls === 1) {
        // agy granted segment 1 (`git status`) but stays at status 9 awaiting
        // the next segment's decision — a re-armed prompt on the same step.
        db.prepare("UPDATE steps SET permissions = ? WHERE idx = 1").run(
          Buffer.from(encodePermissions({ kind: "command", value: "git status", decision: 1 }))
        );
      } else {
        db.prepare("UPDATE steps SET permissions = ?, status = 3 WHERE idx = 1").run(
          Buffer.from(encodePermissions({ kind: "unsandboxed", value: "git log", decision: 1 }))
        );
        insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
        setTimeout(() => pty.emitData("? for shortcuts"), 50);
      }
      db.close();
      return "agy-allow-conversation";
    });
    expect((await result).stopReason).toBe("end_turn");
    // Both segments gated — the second must not be swallowed by toolCallId dedup.
    expect(calls).toBe(2);
    expect(pty.writes).toEqual(["\x1b[B", "\r", "\x1b[B", "\r"]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("re-forwards identical sequential permission prompts on the same step without swallowing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "identical-gates");
      insertStep(db, pendingToolRow("run_command", '{"CommandLine":"echo x && echo x && echo x"}'));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    let calls = 0;
    const result = session.prompt("go", async () => {}, async () => {
      calls++;
      const { default: Database } = await import("better-sqlite3");
      const db = new Database(path.join(dir, "identical-gates.db"));
      if (calls < 3) {
        // Same permission details (kind, value, decision) on consecutive gates
        db.prepare("UPDATE steps SET permissions = ? WHERE idx = 1").run(
          Buffer.from(encodePermissions({ kind: "command", value: "echo x", decision: 1 }))
        );
        // The next identical panel arrives immediately, with no marker-free
        // render or debounce gap between permission generations.
        setTimeout(() => {
          pty.emitData("Yes, and ");
          pty.emitData("always allow");
        }, 5);
      } else {
        db.prepare("UPDATE steps SET permissions = ?, status = 3 WHERE idx = 1").run(
          Buffer.from(encodePermissions({ kind: "command", value: "echo x", decision: 1 }))
        );
        insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
        setTimeout(() => pty.emitData("? for shortcuts"), 50);
      }
      db.close();
      return "agy-allow-once";
    });
    expect((await result).stopReason).toBe("end_turn");
    expect(calls).toBe(3);
    expect(pty.writes).toEqual(["\r", "\r", "\r"]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not treat arrow-key redraws of the same permission panel as another gate", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "gate-footer-redraw");
      insertStep(db, pendingToolRow("run_command"));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    let calls = 0;
    const result = session.prompt("go", async () => {}, async () => {
      calls++;
      // The initial panel render can still be inside the debounce window when
      // the ACP response resolves. The Down key then redraws that same panel.
      pty.emitData("Yes, and always allow");
      setTimeout(() => pty.emitData("Yes, and always allow"), 10);
      setTimeout(async () => {
        const { default: Database } = await import("better-sqlite3");
        const db = new Database(path.join(dir, "gate-footer-redraw.db"));
        updateStep(db, 1, { status: 3 });
        insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
        db.close();
        pty.emitData("? for shortcuts");
      }, 300);
      return "agy-allow-conversation";
    });

    expect((await result).stopReason).toBe("end_turn");
    expect(calls).toBe(1);
    expect(pty.writes).toEqual(["\x1b[B", "\r"]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("bridges single-select ask_question via PTY option keys", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const askInput = JSON.stringify({
      questions: [{
        question: "Which approach?",
        options: ["Option A", "Option B", "Option C"],
        is_multi_select: false
      }]
    });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "ask");
      insertStep(db, pendingToolRow("ask_question", askInput, 138));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const result = session.prompt("clarify", async () => {}, async () => {
      const db = new (await import("better-sqlite3")).default(path.join(dir, "ask.db"));
      updateStep(db, 1, { status: 3 });
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "thanks" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 50);
      return "agy-q-1";
    });
    expect((await result).stopReason).toBe("end_turn");
    expect(pty.writes).toEqual(["\x1b[B\r"]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed for multi-select ask_question without writing keys", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const askInput = JSON.stringify({
      questions: [{
        question: "Pick many",
        options: ["A", "B"],
        is_multi_select: true
      }]
    });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "ask-multi");
      insertStep(db, pendingToolRow("ask_question", askInput, 138));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    await expect(session.prompt("go", async () => {}, async () => "agy-q-0")).rejects.toThrow(/multi-select ask_question/);
    expect(pty.writes).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("bridges replace_file_content permission menus like run_command", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "replace");
      insertStep(db, pendingToolRow("replace_file_content", '{"TargetFile":"/repo/src/cli.ts"}', 5));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const result = session.prompt("edit it", async () => {}, async () => {
      const db = new (await import("better-sqlite3")).default(path.join(dir, "replace.db"));
      updateStep(db, 1, { status: 3 });
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 50);
      return "agy-allow-once";
    });
    expect((await result).stopReason).toBe("end_turn");
    expect(pty.writes).toEqual(["\r"]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });


  it("offers review for an edit that already applied without a live gate, and reverts on reject", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const targetFile = path.join(dir, "target.txt");
    fs.writeFileSync(targetFile, "before\nNEW\nafter", "utf8");
    const rawInputJson = JSON.stringify({ TargetFile: targetFile, TargetContent: "OLD", ReplacementContent: "NEW" });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "already-applied");
      insertStep(db, {
        idx: 1,
        stepType: 5,
        status: 3,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({ call: encodeToolCall({ callId: "edit-1", namePrimary: "replace_file_content", rawInputJson }) })
        })
      });
      db.close();
    });
    const session = interactiveSession(dir, pty);
    let sawKind: string | undefined;
    let sawStatus: string | undefined;
    const result = session.prompt("edit it", async () => {}, async (toolCall) => {
      const raw = toolCall as unknown as { kind?: string; status?: string };
      sawKind = raw.kind;
      sawStatus = raw.status;
      const db = new (await import("better-sqlite3")).default(path.join(dir, "already-applied.db"));
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 0);
      return "reject-once";
    });
    expect((await result).stopReason).toBe("end_turn");
    expect(sawKind).toBe("edit");
    expect(sawStatus).toBe("completed");
    // No live agy gate to answer — nothing sent to the PTY.
    expect(pty.writes).toEqual([]);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("before\nOLD\nafter");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves an already-applied edit in place when the client keeps it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const targetFile = path.join(dir, "target.txt");
    fs.writeFileSync(targetFile, "before\nNEW\nafter", "utf8");
    const rawInputJson = JSON.stringify({ TargetFile: targetFile, TargetContent: "OLD", ReplacementContent: "NEW" });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "already-applied-keep");
      insertStep(db, {
        idx: 1,
        stepType: 5,
        status: 3,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({ call: encodeToolCall({ callId: "edit-1", namePrimary: "replace_file_content", rawInputJson }) })
        })
      });
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const result = session.prompt("edit it", async () => {}, async () => {
      const db = new (await import("better-sqlite3")).default(path.join(dir, "already-applied-keep.db"));
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 0);
      return "allow-once";
    });
    expect((await result).stopReason).toBe("end_turn");
    expect(pty.writes).toEqual([]);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("before\nNEW\nafter");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("routes an already-applied edit through the client's fs write-through instead of asking permission", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const targetFile = path.join(dir, "target.txt");
    fs.writeFileSync(targetFile, "before\nNEW\nafter", "utf8");
    const rawInputJson = JSON.stringify({ TargetFile: targetFile, TargetContent: "OLD", ReplacementContent: "NEW" });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "fs-bridge-route");
      insertStep(db, {
        idx: 1,
        stepType: 5,
        status: 3,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({ call: encodeToolCall({ callId: "edit-1", namePrimary: "replace_file_content", rawInputJson }) })
        })
      });
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const reads: string[] = [];
    const writes: Array<{ path: string; content: string }> = [];
    let permissionCalls = 0;
    const fsBridge = {
      readTextFile: async (p: string) => { reads.push(p); },
      writeTextFile: async (p: string, content: string) => {
        writes.push({ path: p, content });
        fs.writeFileSync(p, content, "utf8");
      }
    };
    const result = session.prompt("edit it", async () => {}, async () => {
      permissionCalls++;
      return "allow-once";
    }, fsBridge);
    setTimeout(async () => {
      const db = new (await import("better-sqlite3")).default(path.join(dir, "fs-bridge-route.db"));
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      pty.emitData("? for shortcuts");
    }, 50);
    expect((await result).stopReason).toBe("end_turn");
    expect(permissionCalls).toBe(0);
    expect(reads).toEqual([targetFile]);
    expect(writes).toEqual([{ path: targetFile, content: "before\nNEW\nafter" }]);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("before\nNEW\nafter");
    expect(pty.writes).toEqual([]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the local permission bridge if the client's fs write-through fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const targetFile = path.join(dir, "target.txt");
    fs.writeFileSync(targetFile, "before\nNEW\nafter", "utf8");
    const rawInputJson = JSON.stringify({ TargetFile: targetFile, TargetContent: "OLD", ReplacementContent: "NEW" });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "fs-bridge-fallback");
      insertStep(db, {
        idx: 1,
        stepType: 5,
        status: 3,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({ call: encodeToolCall({ callId: "edit-1", namePrimary: "replace_file_content", rawInputJson }) })
        })
      });
      db.close();
    });
    const session = interactiveSession(dir, pty);
    let permissionCalls = 0;
    const fsBridge = {
      readTextFile: async () => {},
      writeTextFile: async () => { throw new Error("client rejected the write"); }
    };
    const result = session.prompt("edit it", async () => {}, async () => {
      permissionCalls++;
      const db = new (await import("better-sqlite3")).default(path.join(dir, "fs-bridge-fallback.db"));
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 0);
      return "reject-once";
    }, fsBridge);
    expect((await result).stopReason).toBe("end_turn");
    expect(permissionCalls).toBe(1);
    // The failed write-through must leave disk exactly as it already reported
    // via session/update (newText), not stuck mid-revert.
    expect(fs.readFileSync(targetFile, "utf8")).toBe("before\nOLD\nafter");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("also routes a live-gated edit (default mode) through the client's fs write-through once agy applies it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const targetFile = path.join(dir, "target.txt");
    fs.writeFileSync(targetFile, "before\nOLD\nafter", "utf8");
    const rawInputJson = JSON.stringify({ TargetFile: targetFile, TargetContent: "OLD", ReplacementContent: "NEW" });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "fs-bridge-gated");
      insertStep(db, {
        idx: 1,
        stepType: 5,
        status: 9,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({ call: encodeToolCall({ callId: "edit-1", namePrimary: "replace_file_content", rawInputJson }) })
        })
      });
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const reads: string[] = [];
    const writes: Array<{ path: string; content: string }> = [];
    let permissionCalls = 0;
    const fsBridge = {
      readTextFile: async (p: string) => { reads.push(p); },
      writeTextFile: async (p: string, content: string) => {
        writes.push({ path: p, content });
        fs.writeFileSync(p, content, "utf8");
      }
    };
    const result = session.prompt("edit it", async () => {}, async () => {
      permissionCalls++;
      // Simulate agy itself performing the write after the live gate is answered.
      fs.writeFileSync(targetFile, "before\nNEW\nafter", "utf8");
      const db = new (await import("better-sqlite3")).default(path.join(dir, "fs-bridge-gated.db"));
      updateStep(db, 1, { status: 3 });
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 0);
      return "agy-allow-once";
    }, fsBridge);
    expect((await result).stopReason).toBe("end_turn");
    // Exactly one permission round trip — the live gate itself. The
    // subsequent write-through must not trigger a second local prompt.
    expect(permissionCalls).toBe(1);
    expect(pty.writes).toEqual(["\r"]);
    expect(reads).toEqual([targetFile]);
    expect(writes).toEqual([{ path: targetFile, content: "before\nNEW\nafter" }]);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("before\nNEW\nafter");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("cancels reliably while awaiting permission", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => { const db = createConversationDb(dir, "cancel"); insertStep(db, pendingToolRow("run_command")); db.close(); });
    const session = interactiveSession(dir, pty);
    const pending = session.prompt("go", async () => {}, () => new Promise((resolve) => setTimeout(() => resolve("cancelled"), 300)));
    await new Promise((resolve) => setTimeout(resolve, 220));
    await session.cancel();
    expect((await pending).stopReason).toBe("cancelled");
    expect(pty.writes).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("cancels cleanly while waiting for the permission panel to render", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "cancel-panel-wait");
      insertStep(db, pendingToolRow("run_command"));
      db.close();
    });
    pty.emitPermissionPanelOnStart = false;
    const session = interactiveSession(dir, pty);
    const pending = session.prompt("go", async () => {}, async () => "agy-allow-once");
    setTimeout(() => void session.cancel(), 50);

    expect((await pending).stopReason).toBe("cancelled");
    expect(pty.writes).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("cancels cleanly while waiting for an arrow-key panel redraw", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "cancel-panel-redraw");
      insertStep(db, pendingToolRow("run_command"));
      db.close();
    });
    pty.emitArrowRedraw = false;
    const session = interactiveSession(dir, pty);
    const pending = session.prompt("go", async () => {}, async () => {
      setTimeout(() => void session.cancel(), 50);
      return "agy-allow-conversation";
    });

    expect((await pending).stopReason).toBe("cancelled");
    expect(pty.writes).toEqual(["\x1b[B"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("times out and stops the PTY when no conversation binds", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty();
    const session = interactiveSession(dir, pty, "30ms");
    await expect(session.prompt("go", async () => {}, async () => "cancelled")).rejects.toThrow(/timed out after 30ms/);
    expect(pty.killed).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("configFromEnv", () => {
  it("always invokes agy by name and relies on PATH resolution", () => {
    const config = configFromEnv({
      cwd: "/repo",
      additionalDirectories: ["/repo"],
      env: {
        PATH: "/bin"
      }
    });

    expect(config.agyPath).toBe("agy");
    expect(config.sandbox).toBe(true);
    expect(config.skipPermissions).toBe(false);
    expect(config.promptInArgv).toBe(true);
    expect(config.autoInstall).toBe(false);
    expect(config.interactivePermissions).toBe(true);
  });

  it("configures mode from argv and env", () => {
    expect(configFromEnv({ cwd: "/repo" }).mode).toBe("default");
    expect(configFromEnv({ cwd: "/repo", argv: ["--mode", "accept-edits"] }).mode).toBe("accept-edits");
    expect(
      configFromEnv({
        cwd: "/repo",
        env: { AGY_ACP_MODE: "plan" }
      }).mode
    ).toBe("plan");
    expect(
      configFromEnv({
        cwd: "/repo",
        env: { AGY_ACP_MODE: "plan" },
        argv: ["--mode", "accept-edits"]
      }).mode
    ).toBe("accept-edits");
  });

  it("configures sandbox and skipPermissions based on argv and env", () => {
    const config1 = configFromEnv({
      cwd: "/repo",
      argv: ["--no-sandbox", "--dangerously-skip-permissions"]
    });
    expect(config1.sandbox).toBe(false);
    expect(config1.skipPermissions).toBe(true);
    expect(config1.interactivePermissions).toBe(false);

    const config2 = configFromEnv({
      cwd: "/repo",
      env: {
        AGY_ACP_NO_SANDBOX: "1",
        AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS: "1"
      }
    });
    expect(config2.sandbox).toBe(false);
    expect(config2.skipPermissions).toBe(true);
    expect(config2.interactivePermissions).toBe(false);

    const config3 = configFromEnv({
      cwd: "/repo",
      env: {
        AGY_ACP_SANDBOX: "false"
      }
    });
    expect(config3.sandbox).toBe(false);

    const config4 = configFromEnv({
      cwd: "/repo",
      argv: ["--sandbox"],
      env: {
        AGY_ACP_NO_SANDBOX: "1"
      }
    });
    expect(config4.sandbox).toBe(true);
  });

  it("enables interactive permissions by default and lets the dangerous bypass select print mode", () => {
    expect(configFromEnv({ cwd: "/repo" }).interactivePermissions).toBe(true);
    expect(configFromEnv({ cwd: "/repo", argv: ["--dangerously-skip-permissions"] }).interactivePermissions).toBe(false);
    expect(configFromEnv({ cwd: "/repo", env: { AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS: "1" } }).interactivePermissions).toBe(false);
    expect(configFromEnv({ cwd: "/repo", env: { AGY_ACP_INTERACTIVE_PERMISSIONS: "0" } }).interactivePermissions).toBe(false);
    expect(configFromEnv({ cwd: "/repo", argv: ["--no-interactive-permissions"] }).interactivePermissions).toBe(false);
  });
});

describe("parseAgyModels", () => {
  it("filters status and log lines for modern slug lists", () => {
    expect(parseAgyModels(`
Fetching available models...
I0701 10:23:00.894210 model_config_manager.go:157] log
gemini-3.5-flash-medium
claude-opus-4-6-thinking
gemini-3.5-flash-medium
  `)).toEqual(["gemini-3.5-flash-medium", "claude-opus-4-6-thinking"]);
  });
});

describe("listModels", () => {
  it("discovers models through agy models", async () => {
    const fake = new FakeProcess([`
Fetching available models...
gemini-3.5-flash-medium
claude-opus-4-6-thinking
`]);
    const calls: SpawnCall[] = [];
    const backend = new AgyCliBackend(fake.spawnFactory(calls));

    const models = await backend.listModels(defaultConfig());

    expect(models).toEqual(["gemini-3.5-flash-medium", "claude-opus-4-6-thinking"]);
    expect(calls[0].command).toBe("agy");
    expect(calls[0].args).toEqual(["models"]);
  });
});

describe("prompt", () => {
  it("runs the prompt in argv mode and drains stdout without reading it", async () => {
    const fake = new FakeProcess(["hello ", "world"]);
    const calls: SpawnCall[] = [];
    const session = new AgyCliSession(defaultConfig(), fake.spawnFactory(calls));

    const { updates, stopReason } = await collectUpdates(session, "hello");

    // No conversation database was written, so nothing is streamed — agy's
    // stdout is drained but never interpreted as ACP updates.
    expect(updates).toEqual([]);
    expect(stopReason).toBe("end_turn");
    expect(calls[0].args[calls[0].args.indexOf("--print") + 1]).toBe("hello");
    expect(fake.stdinText).toBe("");
    expect(fake.stdinEnded).toBe(true);
  });

  it("can write prompt through stdin", async () => {
    const fake = new FakeProcess(["ok"]);
    const calls: SpawnCall[] = [];
    const session = new AgyCliSession({ ...defaultConfig(), promptInArgv: false }, fake.spawnFactory(calls));

    await collectUpdates(session, "hello");

    expect(fake.stdinText).toBe("hello");
    expect(fake.stdinEnded).toBe(true);
    expect(calls[0].args[calls[0].args.indexOf("--print") + 1]).not.toBe("hello");
  });

  it("binds the conversation id agy creates, then passes --conversation on the next turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-test-"));
    try {
      const calls: SpawnCall[] = [];
      let turn = 0;
      const session = new AgyCliSession(
        { ...defaultConfig(), conversationsDir: dir },
        (command, args, options) => {
          calls.push({ command, args, options });
          turn += 1;
          if (turn === 1) {
            const db = createConversationDb(dir, "conv-123");
            insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "hi" }) });
            db.close();
          }
          return new FakeProcess([]).spawnFactory([])(command, args, options);
        }
      );

      await collectUpdates(session, "first");
      expect(calls[0].args).not.toContain("--conversation");
      expect(session.conversationId).toBe("conv-123");

      await collectUpdates(session, "second");
      expect(calls[1].args[calls[1].args.indexOf("--conversation") + 1]).toBe("conv-123");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("raises when agy exits nonzero", async () => {
    const fake = new FakeProcess([], { stderr: ["not logged in"], exitCode: 2 });
    const session = new AgyCliSession(defaultConfig(), fake.spawnFactory([]));

    await expect(collectUpdates(session, "hello")).rejects.toThrow(/not logged in/);
  });

  it("can install agy on demand when the default executable is missing", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockImplementation(async (options = {}) => {
      if (options.env) {
        options.env.PATH = `/home/user/.local/bin:${options.env.PATH ?? ""}`;
      }
      return "/home/user/.local/bin/agy";
    });
    const missing = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
    const processes = [
      new FakeProcess([], { spawnError: missing, exitCode: null }),
      new FakeProcess(["ok"])
    ];
    const calls: Array<{ command: string; args: string[] }> = [];
    const session = new AgyCliSession(
      { ...defaultConfig(), autoInstall: true, env: {} },
      (command, args, options) => {
        calls.push({ command, args });
        const process = processes.shift();
        expect(process, `unexpected spawn: ${command}`).toBeDefined();
        return process!.spawnFactory([])(command, args, options);
      }
    );

    const { stopReason } = await collectUpdates(session, "hello");

    expect(stopReason).toBe("end_turn");
    expect(installSpy).toHaveBeenCalledOnce();
    expect(calls.map((call) => call.command)).toEqual(["agy", "agy"]);
    installSpy.mockRestore();
  });

  it("includes install guidance when agy is missing without auto install", async () => {
    const missing = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
    const session = new AgyCliSession(
      defaultConfig(),
      new FakeProcess([], { spawnError: missing, exitCode: null }).spawnFactory([])
    );

    await expect(collectUpdates(session, "hello")).rejects.toThrow(/Install the Google Antigravity CLI/);
  });
});

describe("cancel", () => {
  it("sends SIGINT (not SIGTERM) so agy can flush its conversation database", async () => {
    const fake = new FakeProcess([], { blockStdout: true, exitCode: null });
    const session = new AgyCliSession(defaultConfig(), fake.spawnFactory([]));
    const pending = collectUpdates(session, "hello");

    await new Promise((resolve) => setImmediate(resolve));
    await session.cancel();

    expect(fake.killedWith).toBe("SIGINT");
    expect(session.wasCancelled).toBe(true);
    expect((await pending).stopReason).toBe("cancelled");
  });
});

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

function defaultConfig(): AgyCliConfig {
  return {
    cwd: "/repo",
    additionalDirectories: [],
    agyPath: "agy",
    printTimeout: "5m0s",
    effort: undefined,
    mode: "default",
    sandbox: true,
    skipPermissions: false,
    interactivePermissions: false,
    promptInArgv: true,
    autoInstall: false,
    modelList: [],
    discoverModels: true,
    modelListTimeoutMs: DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS,
    conversationsDir: DEFAULT_CONVERSATIONS_DIR
  };
}

function flagValue(command: string[], flag: string): string {
  return command[command.indexOf(flag) + 1];
}

interface FakeProcessOptions {
  stderr?: string[];
  exitCode?: number | null;
  blockStdout?: boolean;
  spawnError?: Error & { code?: string };
}

class FakeProcess extends EventEmitter {
  stdinText = "";
  stdinEnded = false;
  stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.stdinText += chunk.toString();
      callback();
    },
    final: (callback) => {
      this.stdinEnded = true;
      callback();
    }
  });
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  pid = 1;
  killedWith?: string;
  spawnError?: Error & { code?: string };

  constructor(chunks: string[], options: FakeProcessOptions = {}) {
    super();
    this.spawnError = options.spawnError;
    this.exitCode = options.exitCode === undefined ? 0 : options.exitCode;
    this.stdout = options.blockStdout ? new Readable({ read() {} }) : Readable.from(chunks);
    this.stderr = Readable.from(options.stderr ?? []);
    if (!options.blockStdout && this.exitCode !== null) {
      queueMicrotask(() => this.emit("exit", this.exitCode, null));
    }
  }

  kill(signal?: string) {
    this.killedWith = signal;
    this.exitCode = signal === "SIGKILL" ? -9 : -15;
    this.stdout.push(null);
    this.emit("exit", this.exitCode, signal ?? "SIGTERM");
    return true;
  }

  spawnFactory(calls: SpawnCall[]): SpawnFactory {
    return (command, args, options) => {
      calls.push({ command, args, options });
      if (this.spawnError) {
        queueMicrotask(() => this.emit("error", this.spawnError));
      }
      return this as unknown as ReturnType<SpawnFactory>;
    };
  }
}

function pendingToolRow(name: string, rawInputJson = '{"CommandLine":"echo hi"}', stepType = 21) {
  return { idx: 1, stepType, status: 9, stepPayload: encodeStepPayload({
    toolRun: encodeToolRun({ call: encodeToolCall({ callId: "permission-1", namePrimary: name, rawInputJson }) })
  }) };
}

function interactiveSession(dir: string, pty: FakePty, printTimeout = "3s") {
  return new AgyCliSession({ ...defaultConfig(), conversationsDir: dir, interactivePermissions: true, printTimeout }, undefined, {
    spawn: () => { pty.start(); return pty; }
  } as PtyFactory);
}

function permissionWriteChunks(keys: string): string[] {
  const chunks: string[] = [];
  const down = "\x1b[B";
  let offset = 0;
  while (keys.startsWith(down, offset)) {
    chunks.push(down);
    offset += down.length;
  }
  if (offset < keys.length) chunks.push(keys.slice(offset));
  return chunks;
}

class FakePty implements PtyProcess {
  writes: string[] = [];
  killed = false;
  emitPermissionPanelOnStart = true;
  emitArrowRedraw = true;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number }) => void> = [];
  constructor(private readonly onSpawn?: () => void) {}
  start() {
    this.onSpawn?.();
    queueMicrotask(() => this.emitData(
      this.emitPermissionPanelOnStart ? "? for shortcuts\nYes, and always allow" : "? for shortcuts"
    ));
  }
  write(data: string) {
    this.writes.push(data);
    if (data === "\x1b[B" && this.emitArrowRedraw) {
      setTimeout(() => this.emitData("Yes, and always allow"), 0);
    }
  }
  kill() { this.killed = true; for (const listener of this.exitListeners) listener({ exitCode: 0 }); }
  onData(listener: (data: string) => void) { this.dataListeners.push(listener); return { dispose() {} }; }
  onExit(listener: (event: { exitCode: number }) => void) { this.exitListeners.push(listener); return { dispose() {} }; }
  emitData(data: string) { for (const listener of this.dataListeners) listener(data); }
}
