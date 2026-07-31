// Shared in-memory session shape used across session setup, config options, and the prompt turn.
// Docs: https://agentclientprotocol.com/protocol/v1/session-setup

import type { AgyCliSession } from "../../agy/cli.js";
import type { ModelCatalog } from "../../agy/model/catalog.js";

export interface SessionState {
  sessionId: string;
  cwd: string;
  /** ACP additionalDirectories (excludes cwd). */
  additionalDirectories: string[];
  mcpServers?: unknown;
  agy: AgyCliSession;
  catalog: ModelCatalog;
  selectedBaseModel: string;
  selectedReasoningEffort: string;
  activePrompt: boolean;
  /** Stable v2 user-message IDs keyed by their persisted agy step index. */
  v2UserMessageIdsByStep: Record<string, string>;
  /** Active v2 prompt-turn abort controller, if any. */
  promptAbort?: AbortController;
}
