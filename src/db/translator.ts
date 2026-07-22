// Shared step -> ACP update engine for both live streaming and history replay.
//
// Streaming and replay only really differ in how they treat the agent's text
// stream (step type 15):
//
//   - streaming emits the newly-appended slice each poll (text grows in place
//     at a fixed idx), and re-emits tool steps as `tool_call_update` when their
//     status/content snapshot changes;
//   - replay buffers consecutive agent-text parts and flushes them as one
//     message at each boundary, applying narration filtering across the group.
//
// Everything else — tool calls, titles, user prompts — is identical, so it
// flows through the same per-step dispatcher (`buildUpdatefromStepPayload`).
// This class owns the one row loop; the two modes are just small branches
// inside it.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { filterNarration, isNarration } from "./narration.js";
import { toolCallId } from "./tool-call-updates.js";
import type { StepRow } from "./types.js";
import { buildUpdatefromStepPayload } from "./updates.js";

export type TranslateMode = "stream" | "replay";

export interface TranslatorOptions {
  mode: TranslateMode;
  skipNarration: boolean;
  /** Project working dir, used to render display paths in tool calls. */
  cwd?: string;
}

function agentChunk(text: string, messageId: string): SessionUpdate {
  return {
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text }
  };
}

/** Stable signature of a tool update for progressive re-emission. */
function updateSnapshot(update: SessionUpdate): string {
  const raw = update as unknown as Record<string, unknown>;
  return JSON.stringify({
    sessionUpdate: raw.sessionUpdate,
    toolCallId: raw.toolCallId,
    title: raw.title,
    kind: raw.kind,
    status: raw.status,
    content: raw.content,
    locations: raw.locations,
    rawInput: raw.rawInput,
    rawOutput: raw.rawOutput
  });
}

function asToolCallUpdate(update: SessionUpdate): SessionUpdate {
  return {
    ...(update as object),
    sessionUpdate: "tool_call_update"
  } as SessionUpdate;
}

export class Translator {
  // Streaming: idx -> chars of agent text already emitted (for incremental diff).
  private readonly agentTextLengths = new Map<number, number>();
  // Stream + replay: last emitted snapshot keyed by step idx (tool progressive lifecycle).
  private readonly toolSnapshots = new Map<number, string>();
  // Title-attached think tool cards: emit once per step idx until content changes.
  private readonly titleThoughtSnapshots = new Map<number, string>();
  // Replay: buffered consecutive agent-text parts, flushed at boundaries.
  private readonly pendingAgentParts: string[] = [];
  // Replay: message id for the current buffered agent-text group.
  private pendingAgentMessageId: string | null = null;

  private _lastTitle: string | null = null;
  private _lastStepIdx = -1;
  private _hadUpdates = false;

  constructor(private readonly opts: TranslatorOptions) {}

  /** Highest step idx seen so far. */
  get lastStepIdx(): number {
    return this._lastStepIdx;
  }

  /** Whether any update has been produced across all batches. */
  get hadUpdates(): boolean {
    return this._hadUpdates;
  }

  /** Translate a batch of rows into ordered ACP updates, advancing state. */
  translate(rows: StepRow[]): SessionUpdate[] {
    const out: SessionUpdate[] = [];
    for (const row of rows) this.translateRow(row, out);
    // Replay groups agent text per batch; a batch ends a message boundary.
    if (this.opts.mode === "replay") this.flushAgentBuffer(out);
    if (out.length > 0) this._hadUpdates = true;
    return out;
  }

  private translateRow(row: StepRow, out: SessionUpdate[]): void {
    this._lastStepIdx = Math.max(this._lastStepIdx, row.idx);

    switch (row.stepType) {
      case 15: // agent text chunk
        this.handleAgentText(row, out);
        return;

      case 23: // conversation title
        this.handleTitle(row, out);
        return;

      case 14: // user prompt
        // The streaming client already has its own prompt; only replay re-emits it.
        if (this.opts.mode === "stream") return;
        this.flushAgentBuffer(out);
        this.pushDispatched(row, out);
        return;

      default: {
        // Tool calls and lifecycle steps. In replay, a tool call ends the
        // current agent message. In both modes, progressive status/content
        // changes re-emit as tool_call_update.
        if (this.opts.mode === "replay") {
          this.flushAgentBuffer(out);
        }
        this.pushDispatched(row, out);
      }
    }
  }

  private pushDispatched(row: StepRow, out: SessionUpdate[]): void {
    const update = buildUpdatefromStepPayload(row, this.opts.cwd);
    if (Array.isArray(update)) {
      for (const item of update) this.emitProgressive(row.idx, item, out);
    } else if (update) {
      this.emitProgressive(row.idx, update, out);
    }
  }

  /**
   * Emit a tool update, converting subsequent emissions for the same step idx
   * into `tool_call_update` when the snapshot changes.
   */
  private emitProgressive(stepIdx: number, update: SessionUpdate, out: SessionUpdate[]): void {
    const raw = update as unknown as Record<string, unknown>;
    const kind = raw.sessionUpdate;

    if (kind !== "tool_call" && kind !== "tool_call_update") {
      out.push(update);
      return;
    }

    const snapshot = updateSnapshot(update);
    const previous = this.toolSnapshots.get(stepIdx);
    if (previous === undefined) {
      this.toolSnapshots.set(stepIdx, snapshot);
      // First sight always uses create shape; v2 boundary may rewrite to upsert.
      out.push({ ...raw, sessionUpdate: "tool_call" } as SessionUpdate);
      return;
    }
    if (previous === snapshot) return;

    this.toolSnapshots.set(stepIdx, snapshot);
    out.push(asToolCallUpdate(update));
  }

  private handleTitle(row: StepRow, out: SessionUpdate[]): void {
    const title = row.stepPayload.titleUpdate?.title ?? null;
    const blocks = title?.split("\n\n");
    const currentTitle = blocks?.shift() || null;
    if (currentTitle !== this._lastTitle) {
      this._lastTitle = currentTitle;
      out.push({ sessionUpdate: "session_info_update", title: currentTitle });
    }

    const narration = blocks?.filter((b) => b.trim().length > 0).join("\n\n") ?? "";
    if (!narration) return;

    // Avoid re-emitting the same title-attached Think card on every stream poll.
    const previous = this.titleThoughtSnapshots.get(row.idx);
    if (previous === narration) return;
    this.titleThoughtSnapshots.set(row.idx, narration);

    const thinkUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: toolCallId(row),
      title: "Think",
      kind: "think",
      status: "completed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: narration
          }
        }
      ]
    } as SessionUpdate;

    // First sight for this title step is a create; content changes become updates.
    if (previous === undefined) {
      out.push(thinkUpdate);
    } else {
      out.push(asToolCallUpdate(thinkUpdate));
    }
  }

  private handleAgentText(row: StepRow, out: SessionUpdate[]): void {
    const text = row.stepPayload.agentText?.text ?? "";
    const messageId = String(row.idx);

    if (this.opts.mode === "replay") {
      if (text.length > 0) {
        if (this.pendingAgentMessageId === null) {
          this.pendingAgentMessageId = messageId;
        }
        this.pendingAgentParts.push(text);
      }
      return;
    }

    // Streaming: emit only the slice appended since the last poll for this idx.
    // Chunks for the same step share one messageId (required by ACP v2).
    const emitted = this.agentTextLengths.get(row.idx) ?? 0;
    if (text.length <= emitted) return;
    this.agentTextLengths.set(row.idx, text.length);
    if (this.opts.skipNarration && isNarration(text)) return;
    const delta = text.slice(emitted);
    if (delta.length > 0) out.push(agentChunk(delta, messageId));
  }

  private flushAgentBuffer(out: SessionUpdate[]): void {
    if (this.pendingAgentParts.length === 0) return;
    const text = this.opts.skipNarration
      ? filterNarration(this.pendingAgentParts)
      : this.pendingAgentParts.join("\n");
    const messageId = this.pendingAgentMessageId ?? "agent";
    this.pendingAgentParts.length = 0;
    this.pendingAgentMessageId = null;
    if (text && text.length > 0) out.push(agentChunk(text, messageId));
  }
}
