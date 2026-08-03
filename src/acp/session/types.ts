import type { AgyCliSession } from "../../agy/cli.js";
import type { ModelCatalog } from "../../agy/model/catalog.js";
import type { PromptV1Deps, PromptV2Deps } from "./prompt.js";

export type TurnIntent = "queue" | "steer";

export interface QueuedPromptV1 {
  id: string;
  version: "v1";
  params: import("@agentclientprotocol/sdk").PromptRequest;
  client: import("@agentclientprotocol/sdk").AgentContext;
  signal?: AbortSignal;
  deps: PromptV1Deps;
  resolve: (response: import("@agentclientprotocol/sdk").PromptResponse) => void;
  reject: (error: Error) => void;
}

export interface QueuedPromptV2 {
  id: string;
  version: "v2";
  params: import("@agentclientprotocol/sdk/experimental/v2").PromptRequest;
  client: import("@agentclientprotocol/sdk/experimental/v2").AgentContext;
  promptText: string;
  userMessageId: string;
  controller: AbortController;
  deps: PromptV2Deps;
}

export type QueuedPrompt = QueuedPromptV1 | QueuedPromptV2;

export interface SessionState {
  sessionId: string;
  cwd: string;
  /** ACP additionalDirectories (excludes cwd). */
  additionalDirectories: string[];
  agy: AgyCliSession;
  catalog: ModelCatalog;
  selectedBaseModel: string;
  selectedReasoningEffort: string;
  activePrompt: boolean;
  /** Per-session FIFO of queued follow-up prompts. */
  promptQueue: QueuedPrompt[];
  /** Resolves when the active turn reaches idle and the queue consumer can proceed. */
  promptIdleNotify?: () => void;
  /** Stable v2 user-message IDs keyed by their persisted agy step index. */
  v2UserMessageIdsByStep: Record<string, string>;
  /** Active v2 prompt-turn abort controller, if any. */
  promptAbort?: AbortController;
}
