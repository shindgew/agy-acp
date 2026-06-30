// Live streaming poller for an in-flight prompt turn. Holds one open DB handle
// for the turn and drives the shared Translator in "stream" mode, emitting only
// newly-appended agent text and not-yet-sent tool steps on each poll.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { ConversationDb } from "./database.js";
import { newConversationId } from "./scan.js";
import { Translator } from "./translator.js";

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

    return this.translator.translate(this.db.readAfter(this.opts.baseStepIdx));
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
