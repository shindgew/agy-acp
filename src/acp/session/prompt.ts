// ACP session/prompt: user message, agent execution loop, permission requests.
// Docs: https://agentclientprotocol.com/protocol/v1/prompt-turn

import { randomUUID } from "node:crypto";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import type {
  AgentContext as V1AgentContext,
  PromptRequest as V1PromptRequest,
  PromptResponse as V1PromptResponse
} from "@agentclientprotocol/sdk";
import type {
  AgentContext as V2AgentContext,
  PromptRequest as V2PromptRequest,
  PromptResponse as V2PromptResponse
} from "@agentclientprotocol/sdk/experimental/v2";
import type { SessionModeId } from "../../agy/cli.js";
import { contentBlocksToPrompt } from "../content/index.js";
import type { ClientFileSystem } from "../../agy/edit/bridge.js";
import { interpretSlashCommand, parseSlashCommand, resolveModelValue } from "../slash-commands/index.js";
import { MODEL_CONFIG_ID } from "./config-options.js";
import { MODE_CONFIG_ID } from "./modes.js";
import { requestPermissionV1, requestPermissionV2 } from "./request-permission.js";
import type { SessionState } from "./types.js";
import { expandSessionUpdateToV2, sessionUpdateToV1 } from "./update-wire.js";

export interface PromptTurnDeps {
  requireSession(sessionId: string): SessionState;
  applyConfigOption(sessionId: string, configId: string, value: unknown): Promise<void>;
  persistSession(sessionId: string, session: SessionState): Promise<void>;
}

export interface PromptV1Deps extends PromptTurnDeps {
  notifyCurrentModeUpdate(client: V1AgentContext, sessionId: string, mode: SessionModeId): Promise<void>;
  notifyConfigOptionUpdateV1(client: V1AgentContext, sessionId: string, session: SessionState): Promise<void>;
  clientFileSystemV1(client: V1AgentContext, sessionId: string): ClientFileSystem | undefined;
}

export interface PromptV2Deps extends PromptTurnDeps {
  notifyConfigOptionUpdateV2(client: V2AgentContext, sessionId: string, session: SessionState): Promise<void>;
}

/**
 * Honor curated ACP slash commands that map onto session config (mode / model /
 * reasoningEffort). Returns true when the prompt was fully handled without
 * spawning agy. Unknown or non-slash prompts return false (pass through).
 */
export async function applyCuratedSlashCommand(
  sessionId: string,
  promptText: string,
  notify: {
    modeChanged?: (mode: SessionModeId) => Promise<void>;
    configChanged: () => Promise<void>;
  },
  deps: PromptTurnDeps
): Promise<boolean> {
  const parsed = parseSlashCommand(promptText);
  if (!parsed) return false;

  const result = interpretSlashCommand(parsed);
  if (result.kind === "pass") return false;
  if (result.kind === "error") {
    throw new Error(result.message);
  }

  const session = deps.requireSession(sessionId);
  let value = result.value;
  if (result.configId === MODEL_CONFIG_ID) {
    const resolved = resolveModelValue(value, session.catalog);
    if (!resolved) {
      throw new Error(`Unknown model: ${value}`);
    }
    value = resolved;
  }

  const previousMode = session.agy.config.mode;
  await deps.applyConfigOption(sessionId, result.configId, value);
  const after = deps.requireSession(sessionId);

  if (
    result.configId === MODE_CONFIG_ID &&
    after.agy.config.mode !== previousMode &&
    notify.modeChanged
  ) {
    await notify.modeChanged(after.agy.config.mode);
  }
  await notify.configChanged();
  return true;
}

/** v1 `session/prompt`: response carries stopReason after the full turn. */
export async function handlePromptV1(
  params: V1PromptRequest,
  client: V1AgentContext,
  signal: AbortSignal | undefined,
  deps: PromptV1Deps
): Promise<V1PromptResponse> {
  const session = deps.requireSession(params.sessionId);
  if (session.activePrompt) {
    throw new Error(`Session already has an active prompt: ${params.sessionId}`);
  }

  const prompt = await contentBlocksToPrompt(params.prompt, session.cwd);

  // Curated slash commands → config options; do not spawn agy for those.
  const handled = await applyCuratedSlashCommand(
    params.sessionId,
    prompt,
    {
      modeChanged: (mode) => deps.notifyCurrentModeUpdate(client, params.sessionId, mode),
      configChanged: async () => {
        await deps.notifyConfigOptionUpdateV1(
          client,
          params.sessionId,
          deps.requireSession(params.sessionId)
        );
      }
    },
    deps
  );
  if (handled) {
    return { stopReason: signal?.aborted ? "cancelled" : "end_turn" };
  }

  session.activePrompt = true;
  const cancelPrompt = () => {
    session.agy.cancel().catch(() => {
      // The prompt loop will surface process failures through its own result.
    });
  };
  signal?.addEventListener("abort", cancelPrompt, { once: true });

  try {
    const outcome = await session.agy.prompt(prompt, async (update) => {
      await client.notify(v1.methods.client.session.update, {
        sessionId: params.sessionId,
        update: sessionUpdateToV1(update)
      });
    }, async (toolCall, { toolName }) => {
      return requestPermissionV1(client, params.sessionId, toolCall, toolName, signal);
    }, deps.clientFileSystemV1(client, params.sessionId));
    await deps.persistSession(params.sessionId, session);
    return {
      stopReason: outcome.stopReason === "cancelled" || signal?.aborted ? "cancelled" : "end_turn"
    };
  } catch (error) {
    // Persist even on failure: agy's conversation id/step position may have
    // advanced before it errored out, and that partial progress is worth
    // resuming from on the next prompt.
    await deps.persistSession(params.sessionId, session).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelPrompt);
    session.activePrompt = false;
  }
}

/**
 * v2 `session/prompt`: respond `{}` immediately on acceptance. Foreground
 * progress and stopReason arrive as `state_update` notifications.
 */
export async function handlePromptV2(
  params: V2PromptRequest,
  client: V2AgentContext,
  deps: PromptV2Deps
): Promise<V2PromptResponse> {
  const session = deps.requireSession(params.sessionId);
  if (session.activePrompt) {
    throw new Error(`Session already has an active prompt: ${params.sessionId}`);
  }

  // Content block shapes are compatible at runtime; v1/v2 TS types diverge on open enums.
  const promptText = await contentBlocksToPrompt(params.prompt as v1.ContentBlock[], session.cwd);
  session.activePrompt = true;
  const controller = new AbortController();
  session.promptAbort = controller;

  // Queue the empty acceptance response before any session/update from the turn.
  // Work starts on the next event-loop task (see dual-version-agent example).
  const responseQueued = new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

  void responseQueued
    .then(() => runV2PromptTurn(params, client, session, promptText, controller.signal, deps))
    .catch((error) => {
      console.error(`[agy-acp] v2 prompt turn failed: ${(error as Error).message}`);
    })
    .finally(() => {
      if (session.promptAbort === controller) {
        session.promptAbort = undefined;
      }
      session.activePrompt = false;
    });

  return {};
}

async function runV2PromptTurn(
  params: V2PromptRequest,
  client: V2AgentContext,
  session: SessionState,
  promptText: string,
  signal: AbortSignal,
  deps: PromptV2Deps
): Promise<void> {
  const notify = async (update: v2.SessionUpdate) => {
    await client.notify(v2.methods.client.session.update, {
      sessionId: params.sessionId,
      update
    });
  };

  const userMessageId = randomUUID();
  try {
    signal.throwIfAborted();

    // User message acknowledgment — source of truth for agent-owned messageId.
    await notify({
      sessionUpdate: "user_message",
      messageId: userMessageId,
      content: params.prompt as v2.ContentBlock[]
    });

    signal.throwIfAborted();
    await notify({ sessionUpdate: "state_update", state: "running" });

    // Curated slash commands → config options (no agy spawn).
    const slashHandled = await applyCuratedSlashCommand(
      params.sessionId,
      promptText,
      {
        configChanged: async () => {
          await deps.notifyConfigOptionUpdateV2(client, params.sessionId, deps.requireSession(params.sessionId));
        }
      },
      deps
    );
    if (slashHandled) {
      await notify({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: signal.aborted ? "cancelled" : "end_turn"
      });
      return;
    }

    const cancelPrompt = () => {
      session.agy.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancelPrompt, { once: true });

    try {
      const outcome = await session.agy.prompt(promptText, async (update) => {
        for (const v2Update of expandSessionUpdateToV2(update)) {
          await notify(v2Update);
        }
      }, async (toolCall, { toolName }) => {
        return requestPermissionV2(client, params.sessionId, toolCall, toolName, signal);
      });
      await deps.persistSession(params.sessionId, session);

      const stopReason =
        outcome.stopReason === "cancelled" || signal.aborted ? "cancelled" : "end_turn";
      await notify({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason
      });
    } finally {
      signal.removeEventListener("abort", cancelPrompt);
    }
  } catch (error) {
    await deps.persistSession(params.sessionId, session).catch(() => {});
    if (signal.aborted) {
      await notify({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled"
      });
      return;
    }
    // Surface a failed turn as idle so the client is not left in `running`.
    await notify({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "end_turn"
    });
    throw error;
  }
}
