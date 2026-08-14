// Live streaming poller for an in-flight prompt turn. Holds one open DB handle
// for the turn and drives the shared Translator in "stream" mode, emitting only
// newly-appended agent text and not-yet-sent tool steps on each poll.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { ConversationDb } from "./database.js";
import type { GenMetadataUsage } from "./gen-metadata.js";
import { newConversationId } from "./scan.js";
import { isSystemMessage } from "./system-message.js";
import { toolCallId } from "./tool-call-updates.js";
import { Translator } from "./translator.js";
import type { StepRow } from "./types.js";
import { LIFECYCLE_STEP_TYPES } from "./updates.js";

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
  /** Highest gen_metadata idx seen before this turn. */
  baseGenMetadataIdx?: number;
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
  /** Launched background task id -> idx of the first row that carried it. */
  private readonly _launchedTaskIdxs = new Map<string, number>();
  private readonly _completedTaskIds = new Set<string>();
  private _latestGenMetadata: GenMetadataUsage | null = null;
  private _lastGenMetadataIdx = -1;
  private readonly _promptGenMetadataRows: GenMetadataUsage[] = [];
  private _lastObservedRows: StepRow[] = [];

  constructor(private readonly opts: StreamOptions) {
    this.boundId = opts.conversationId;
    this._lastGenMetadataIdx = opts.baseGenMetadataIdx ?? -1;
    this.translator = new Translator({
      mode: "stream",
      skipNarration: opts.skipNarration,
      cwd: opts.cwd
    });
  }

  get conversationId(): string | null {
    return this.boundId;
  }

  get latestGenMetadata(): GenMetadataUsage | null {
    return this._latestGenMetadata;
  }

  get lastGenMetadataIdx(): number {
    return Math.max(this._lastGenMetadataIdx, this.opts.baseGenMetadataIdx ?? -1);
  }

  /**
   * Accumulate all generation metadata rows produced during this prompt turn
   * for terminal token usage reporting.
   */
  accumulatedTurnUsage(): {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    thoughtTokens?: number | null;
    cachedReadTokens?: number | null;
  } | undefined {
    if (this._promptGenMetadataRows.length === 0) return undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let thoughtTokens = 0;
    let cachedReadTokens = 0;
    for (const g of this._promptGenMetadataRows) {
      inputTokens += g.totalInputTokens;
      outputTokens += g.candidatesTokens;
      thoughtTokens += g.thoughtTokens;
      cachedReadTokens += g.cachedTokens;
    }
    return {
      totalTokens: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      thoughtTokens: thoughtTokens > 0 ? thoughtTokens : undefined,
      cachedReadTokens: cachedReadTokens > 0 ? cachedReadTokens : undefined
    };
  }

  /**
   * Evaluates the non-cancellation stop reason for the turn based on observed
   * model errors, output ceilings, and token limits.
   */
  detectStopReason(): "end_turn" | "max_tokens" | "refusal" {
    for (const g of this._promptGenMetadataRows) {
      if (g.maxOutputTokens && g.maxOutputTokens > 0 && g.candidatesTokens >= g.maxOutputTokens) {
        return "max_tokens";
      }
    }
    for (const row of this._lastObservedRows) {
      const pe = row.stepPayload.modelProviderError;
      if (pe) {
        const text = (pe.summary + " " + pe.userMessage + " " + pe.diagnostic).toLowerCase();
        if (
          text.includes("safety") ||
          text.includes("content filter") ||
          text.includes("policy") ||
          text.includes("refusal") ||
          text.includes("blocked")
        ) {
          return "refusal";
        }
        if (
          text.includes("context length") ||
          text.includes("max_tokens") ||
          text.includes("maximum context") ||
          text.includes("token limit") ||
          text.includes("max output tokens") ||
          text.includes("output token limit")
        ) {
          return "max_tokens";
        }
      }
      if (row.error) {
        const errText = (row.error.message + " " + row.error.detail).toLowerCase();
        if (
          errText.includes("context length") ||
          errText.includes("max tokens") ||
          errText.includes("token limit") ||
          errText.includes("max output tokens") ||
          errText.includes("output token limit")
        ) {
          return "max_tokens";
        }
      }
    }
    return "end_turn";
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
    // _lastUserStepIdx starts at -1, so `>` already excludes "no system message".
    return this._latestSystemMessageStepIdx > this._lastUserStepIdx;
  }

  /**
   * True while this user turn should stay open for background work.
   * Driven strictly by SQLite protobuf task_details launch and completion state.
   */
  get hasActiveBackgroundTasks(): boolean {
    return this._launchedTaskIdxs.size > this._completedTaskIds.size;
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
      }
      if (row.task?.taskId && !this._launchedTaskIdxs.has(row.task.taskId)) {
        this._launchedTaskIdxs.set(row.task.taskId, row.idx);
      }
      const text = row.stepPayload.agentText?.text ?? "";
      // Defer completion tracking until a system message is terminal so a
      // still-streaming system-message envelope cannot close the wait early.
      // Generic stepType 101 turn-end markers without a system message payload
      // must NOT clear active tasks, as agy appends 101 at the end of every turn.
      const taskLaunchIdx = row.task?.taskId ? this._launchedTaskIdxs.get(row.task.taskId) : undefined;
      const isTaskTerminalRow =
        taskLaunchIdx !== undefined &&
        (row.idx > taskLaunchIdx || row.stepType !== 21) &&
        isTerminalStepStatus(row.status);
      if (
        (isSystemMessage(text) || isTaskTerminalRow) &&
        isTerminalStepStatus(row.status)
      ) {
        if (isSystemMessage(text)) {
          this._latestSystemMessageStepIdx = Math.max(this._latestSystemMessageStepIdx, row.idx);
        }
        // Rows are re-read on every poll, so an id-less lifecycle row observed
        // before a later launch would otherwise close that newer task on the
        // next revision. Only tasks launched BEFORE this row can complete here.
        const launchedBefore = [...this._launchedTaskIdxs]
          .filter(([, launchIdx]) => launchIdx < row.idx || (launchIdx === row.idx && row.stepType !== 21))
          .map(([taskId]) => taskId);
        let matchedTask = false;
        if (row.task?.taskId && isTaskTerminalRow) {
          this._completedTaskIds.add(row.task.taskId);
          matchedTask = true;
        }
        for (const taskId of launchedBefore) {
          if (taskId && textMentionsTaskId(text, taskId)) {
            this._completedTaskIds.add(taskId);
            matchedTask = true;
          }
        }
        // Lifecycle/system wake without an embedded task id (common for system message
        // wakes): close every still-pending launch so the turn cannot hang
        // forever waiting for a match that never arrives.
        if (!matchedTask) {
          for (const taskId of launchedBefore) {
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
    const latest = rows.at(-1);
    const latestMeaningful = findLastMeaningfulStep(rows);
    const isEmptyAgentText = latest !== undefined && isEmptyAgentTextStep(latest);
    this._busy = latest !== undefined && (!isTerminalStepStatus(latest.status) || isEmptyAgentText);
    // A turn can end on a completed agent message, but also on a terminal tool
    // step with no trailing message — most notably a denied/failed command
    // (status 7), after which agy returns to idle without emitting more text.
    // Gate completion on "latest meaningful step is terminal" (3/6/7) while no
    // subsequent step is currently busy, rather than naively checking rows.at(-1).
    // This excludes early lifecycle rows (90, 98, 101), system message notices,
    // and empty stepType 15 placeholders that agy inserts while preparing generation.
    this._latestStepTerminal =
      !rows.hasDecodeError &&
      latestMeaningful !== undefined &&
      !this._busy &&
      isTerminalStepStatus(latestMeaningful.status);
    this._lastObservedRows = rows;

    const genRows = this.db.readGenMetadataAfter(this._lastGenMetadataIdx);
    if (genRows.length > 0) {
      this._lastGenMetadataIdx = Math.max(this._lastGenMetadataIdx, ...genRows.map((g) => g.idx));
      this._latestGenMetadata = genRows.at(-1) ?? this._latestGenMetadata;
      this._promptGenMetadataRows.push(...genRows);
    }
    const usageUpdates = this.translator.translateUsage(genRows);
    // readAfter(baseStepIdx) is a complete prompt-scoped snapshot on every DB
    // change. Rebuild derived file history from those rows so completed writes
    // from a prior poll cannot become the oldText of an earlier historical row.
    this.translator.resetFileContentsForFullReplay();
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
    return [...usageUpdates, ...updates];
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

/** status 3/6/7 — completed, cancelled/aborted, or failed. */
function isTerminalStepStatus(status: number): boolean {
  return status === 3 || status === 6 || status === 7;
}

/**
 * Step types recorded by agy for its own bookkeeping, prompt framing, or notifications,
 * which do not represent assistant tool execution or assistant response generation.
 */
function isIgnoredTurnStep(row: StepRow): boolean {
  if (row.stepType === 14) return true;
  if (row.stepType === 23) return true;
  if (LIFECYCLE_STEP_TYPES.has(row.stepType)) return true;
  if (row.stepType === 15) {
    const text = row.stepPayload.agentText?.text ?? "";
    if (isSystemMessage(text)) return true;
    if (isEmptyAgentTextStep(row)) return true;
  }
  return false;
}

function findLastMeaningfulStep(rows: StepRow[]): StepRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (!isIgnoredTurnStep(row)) return row;
  }
  return undefined;
}

/**
 * True when stepType 15 carries no visible agent text and no thought text.
 * agy appends an empty stepType 15 row with status 3 while initializing
 * assistant response generation, which must NOT trigger turn completion.
 */
function isEmptyAgentTextStep(row: StepRow): boolean {
  if (row.stepType !== 15) return false;
  const text = row.stepPayload.agentText?.text ?? "";
  // System message envelopes carry real (internal) content — they are not the
  // empty placeholders agy inserts while initializing response generation.
  if (isSystemMessage(text)) return false;
  const thought = row.stepPayload.agentText?.thought;
  const hasText = text.length > 0;
  const hasThought = Boolean(thought && thought.length > 0);
  return !hasText && !hasThought;
}

/**
 * True when `text` contains `taskId` as a whole token (not a prefix of a longer
 * id). Avoids `task-1` matching inside `task-10`.
 */
function textMentionsTaskId(text: string, taskId: string): boolean {
  if (!taskId || !text) return false;
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(taskId, from);
    if (index < 0) return false;
    const before = index === 0 ? "" : text[index - 1]!;
    const after = text[index + taskId.length] ?? "";
    const boundary = (ch: string) => ch === "" || !/[\w-]/.test(ch);
    if (boundary(before) && boundary(after)) return true;
    from = index + 1;
  }
  return false;
}
