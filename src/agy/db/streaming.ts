// Live streaming poller for an in-flight prompt turn. Holds one open DB handle
// for the turn and drives the shared Translator in "stream" mode, emitting only
// newly-appended agent text and not-yet-sent tool steps on each poll.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { ConversationDb } from "./database.js";
import { newConversationId } from "./scan.js";
import { toolCallId } from "./tool-call-updates.js";
import { Translator } from "./translator.js";
import type { StepRow } from "./types.js";

export interface PendingInteraction {
  update: SessionUpdate;
  row: StepRow;
  toolName: string;
  /**
   * True when agy itself is blocked awaiting this decision (status 9, the
   * interactive confirmation menu). False for an edit that already completed
   * without ever pausing (accept-edits / skip-permissions / any non-gated
   * mode) — offered for review after the fact, since the write already
   * happened.
   */
  blocked: boolean;
}

export interface StreamOptions {
  dir: string;
  /** Bound conversation id, or null to bind the DB agy creates for a fresh prompt. */
  conversationId: string | null;
  /** Highest idx already delivered to the client before this turn. */
  baseStepIdx: number;
  skipNarration: boolean;
  cwd?: string;
  /** Snapshot of conversation ids before the prompt, for binding a new DB. */
  snapshot: Set<string> | null;
}

export class StreamPoller {
  private readonly translator: Translator;
  private db: ConversationDb | null = null;
  private boundId: string | null;
  private _pending: PendingInteraction[] = [];
  private _hasRows = false;
  private _busy = false;
  private _latestAgentComplete = false;
  private _revision = 0;
  private dataVersion: number | null = null;
  private rowSnapshot = "";

  constructor(private readonly opts: StreamOptions) {
    this.boundId = opts.conversationId;
    this.translator = new Translator({
      mode: "stream",
      skipNarration: opts.skipNarration,
      cwd: opts.cwd
    });
  }

  get conversationId(): string | null {
    return this.boundId;
  }

  get lastStepIdx(): number {
    return Math.max(this.translator.lastStepIdx, this.opts.baseStepIdx);
  }

  get hadUpdates(): boolean {
    return this.translator.hadUpdates;
  }

  /** Newly observed status-9 tool calls from the most recent poll. */
  takePending(): PendingInteraction[] {
    const pending = this._pending;
    this._pending = [];
    return pending;
  }

  get turnCompleteCandidate(): boolean {
    return this._hasRows && !this._busy && this._latestAgentComplete;
  }

  /** Increments whenever the observed rows (including growing in-place rows) change. */
  get revision(): number { return this._revision; }

  /** Read steps appended since the turn began and translate the new ones. */
  poll(): SessionUpdate[] {
    if (this.boundId === null && this.opts.snapshot !== null) {
      this.boundId = newConversationId(this.opts.dir, this.opts.snapshot);
    }
    if (this.boundId === null) return [];

    if (this.db === null) {
      this.db = ConversationDb.open(this.opts.dir, this.boundId);
      if (this.db === null) return [];
    }

    const dataVersion = this.db.dataVersion();
    if (this.dataVersion === dataVersion) return [];
    this.dataVersion = dataVersion;

    const rows = this.db.readAfter(this.opts.baseStepIdx);
    const snapshot = JSON.stringify(rows.map((row) => [
      row.idx,
      row.stepType,
      row.status,
      row.stepPayload,
      row.error,
      row.permission,
      row.task
    ]));
    if (snapshot !== this.rowSnapshot) { this.rowSnapshot = snapshot; this._revision++; }
    this._hasRows = rows.length > 0;
    this._busy = rows.some((row) => row.status !== 3 && row.status !== 6 && row.status !== 7);
    const latest = rows.at(-1);
    this._latestAgentComplete = latest?.stepType === 15 && latest.status === 3;
    const updates = this.translator.translate(rows);
    const rowsByToolCallId = new Map(rows.map((row) => [toolCallId(row), row]));
    for (const update of updates) {
      const raw = update as unknown as { status?: string; kind?: string; toolCallId?: string };
      const blocked = raw.status === "pending";
      // Edits that complete without ever pausing (accept-edits / skip-permissions)
      // still get offered for review — see PendingInteraction.blocked.
      const completedEdit = raw.kind === "edit" && raw.status === "completed";
      if (!blocked && !completedEdit) continue;
      const id = String(raw.toolCallId);
      const row = rowsByToolCallId.get(id);
      if (row) {
        this._pending.push({
          update,
          row,
          toolName: row.stepPayload.toolRun?.call?.namePrimary || row.stepPayload.toolRun?.call?.nameSecondary || "unknown",
          blocked
        });
      }
    }
    return updates;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
