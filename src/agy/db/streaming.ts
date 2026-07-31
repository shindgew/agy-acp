// Live streaming poller for an in-flight prompt turn. Holds one open DB handle
// for the turn and drives the shared Translator in "stream" mode, emitting only
// newly-appended agent text and not-yet-sent tool steps on each poll.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { ConversationDb } from "./database.js";
import { newConversationId } from "./scan.js";
import { isSystemMessage } from "./system-message.js";
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
  private _latestStepTerminal = false;
  private _revision = 0;
  private dataVersion: number | null = null;
  private failedDataVersion: number | null = null;
  private failedDataVersionAttempts = 0;
  private rowSnapshot = "";
  private readonly activePending = new Map<string, PendingInteraction>();
  private readonly observedUserStepIdxs = new Set<number>();
  private _lastUserStepIdx = -1;
  private _latestSystemMessageStepIdx = -1;
  private _hasBackgroundWaiting = false;
  private readonly _launchedTaskIds = new Set<string>();
  private readonly _completedTaskIds = new Set<string>();

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

  /** User-prompt rows observed during this prompt-scoped polling session. */
  get userStepIdxs(): number[] {
    return [...this.observedUserStepIdxs];
  }

  get lastUserStepIdx(): number {
    return this._lastUserStepIdx;
  }

  get latestSystemMessageStepIdx(): number {
    return this._latestSystemMessageStepIdx;
  }

  get hasUnansweredSystemMessage(): boolean {
    return this._latestSystemMessageStepIdx > this._lastUserStepIdx && this._latestSystemMessageStepIdx !== -1;
  }

  /**
   * True while this user turn should stay open for background work.
   * Prefer explicit task_details launch/completion tracking; fall back to the
   * "preserving context / waiting for background" agent text plus a later
   * system/lifecycle message. Never requires injecting a synthetic prompt.
   */
  get hasActiveBackgroundTasks(): boolean {
    if (this._launchedTaskIds.size > this._completedTaskIds.size) return true;
    return this._hasBackgroundWaiting && !this.hasUnansweredSystemMessage;
  }

  /** Newly observed status-9 tool calls from the most recent poll. */
  takePending(): PendingInteraction[] {
    const pending = this._pending;
    this._pending = [];
    return pending;
  }

  /** Requeue a still-blocked interaction when the TUI redraws an identical gate. */
  requeuePending(id: string): boolean {
    if (this._pending.some((interaction) => toolCallId(interaction.row) === id)) return false;
    const interaction = this.activePending.get(id);
    if (!interaction) return false;
    this._pending.push(interaction);
    return true;
  }

  get turnCompleteCandidate(): boolean {
    return this._hasRows && !this._busy && this._latestStepTerminal;
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

    const rows = this.db.readAfter(this.opts.baseStepIdx);
    for (const row of rows) {
      if (row.stepType === 14) {
        this.observedUserStepIdxs.add(row.idx);
        this._lastUserStepIdx = Math.max(this._lastUserStepIdx, row.idx);
        this._hasBackgroundWaiting = false;
      }
      if (row.task?.taskId) {
        this._launchedTaskIds.add(row.task.taskId);
      }
      const text = row.stepPayload.agentText?.text ?? "";
      // Only enter the background-wait path with corroborating task evidence.
      // A bare prose mention of "preserving context" must not pin the turn open
      // (and eventually time out) when no background task was launched.
      if (
        this._launchedTaskIds.size > 0 &&
        text &&
        isBackgroundWaitAgentText(text)
      ) {
        this._hasBackgroundWaiting = true;
      }
      // Defer completion tracking until the lifecycle row is terminal so a
      // still-streaming system-message envelope cannot close the wait early.
      if (
        (row.stepType === 101 || isSystemMessage(text)) &&
        isTerminalStepStatus(row.status)
      ) {
        this._latestSystemMessageStepIdx = Math.max(this._latestSystemMessageStepIdx, row.idx);
        let matchedTask = false;
        for (const taskId of this._launchedTaskIds) {
          if (taskId && text.includes(taskId)) {
            this._completedTaskIds.add(taskId);
            matchedTask = true;
          }
        }
        // Lifecycle/system wake without an embedded task id (common for stop_hook
        // type 101): close every still-pending launch so the turn cannot hang
        // forever waiting for a match that never arrives.
        if (!matchedTask) {
          for (const taskId of this._launchedTaskIds) {
            this._completedTaskIds.add(taskId);
          }
        }
      }
    }
    if (!rows.hasDecodeError) {
      this.dataVersion = dataVersion;
      this.failedDataVersion = null;
      this.failedDataVersionAttempts = 0;
    } else {
      if (this.failedDataVersion === dataVersion) {
        this.failedDataVersionAttempts++;
      } else {
        this.failedDataVersion = dataVersion;
        this.failedDataVersionAttempts = 1;
      }
      if (this.failedDataVersionAttempts >= 3) {
        this.dataVersion = dataVersion;
      }
    }
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
    // A turn can end on a completed agent message, but also on a terminal tool
    // step with no trailing message — most notably a denied/failed command
    // (status 7), after which agy returns to idle without emitting more text.
    // Gate completion on "latest step is terminal" (3/6/7), not "latest is an
    // agent message", so those turns don't hang until the deadline. Exclude
    // stepType 14 (user prompt), which is inserted with status 3 as the turn
    // opens before agy appends any assistant response steps.
    this._latestStepTerminal =
      !rows.hasDecodeError &&
      latest !== undefined &&
      latest.stepType !== 14 &&
      (latest.status === 3 || latest.status === 6 || latest.status === 7);
    const updates = this.translator.translate(rows);
    const rowsByToolCallId = new Map(rows.map((row) => [toolCallId(row), row]));
    const blockedIds = new Set(rows.filter((row) => row.status === 9).map(toolCallId));
    for (const id of this.activePending.keys()) {
      if (!blockedIds.has(id)) this.activePending.delete(id);
    }
    for (const update of updates) {
      const raw = update as unknown as { status?: string; kind?: string; toolCallId?: string };
      const blocked = raw.status === "pending";
      const id = String(raw.toolCallId);
      // Edits that complete without ever pausing (accept-edits / skip-permissions)
      // still get offered for review — see PendingInteraction.blocked.
      const completedEdit = raw.kind === "edit" && raw.status === "completed";
      if (!blocked && !completedEdit) continue;
      const row = rowsByToolCallId.get(id);
      if (row) {
        const interaction = {
          update,
          row,
          toolName: row.stepPayload.toolRun?.call?.namePrimary || row.stepPayload.toolRun?.call?.nameSecondary || "unknown",
          blocked
        };
        if (blocked) this.activePending.set(id, interaction);
        this._pending.push(interaction);
      }
    }
    return updates;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

/** agy's known lifecycle prose when it parks a turn on a background task. */
const BACKGROUND_WAIT_SENTINEL =
  "Preserving context while waiting for background command output...";

function isBackgroundWaitAgentText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === BACKGROUND_WAIT_SENTINEL) return true;
  // Slight variants still seen with task_details present.
  return /waiting for.*background|preserving context while waiting/i.test(trimmed);
}

/** status 3/6/7 — completed, cancelled/aborted, or failed. */
function isTerminalStepStatus(status: number): boolean {
  return status === 3 || status === 6 || status === 7;
}

