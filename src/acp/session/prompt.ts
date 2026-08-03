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
import type { ClientElicitationCapability } from "../tool-calls/elicitation.js";
import type { ClientToolCallNameCapability } from "../initialize.js";
import type { SessionModeId } from "../../agy/cli.js";
import { contentBlocksToPrompt } from "../content/index.js";
import type { ClientFileSystem } from "../../agy/edit/bridge.js";
import {
  interpretSlashCommand,
  isClientTextSlashPrompt,
  parseSlashCommand,
  resolveModelValue
} from "../slash-commands/index.js";
import { MODEL_CONFIG_ID } from "./config-options.js";
import { MODE_CONFIG_ID } from "./modes.js";
import { requestPermissionV1, requestPermissionV2 } from "./request-permission.js";
import type { QueuedPromptV1, QueuedPromptV2, SessionState, TurnIntent } from "./types.js";
import { createTerminalOutputTracker, createToolCallContentTracker, expandSessionUpdateToV2, sessionUpdateToV1 } from "./update-wire.js";

export interface PromptTurnDeps {
  requireSession(sessionId: string): SessionState;
  applyConfigOption(sessionId: string, configId: string, value: unknown): Promise<void>;
  persistSession(sessionId: string, session: SessionState): Promise<void>;
}

export interface PromptV1Deps extends PromptTurnDeps {
  notifyCurrentModeUpdate(client: V1AgentContext, sessionId: string, mode: SessionModeId): Promise<void>;
  notifyConfigOptionUpdateV1(client: V1AgentContext, sessionId: string, session: SessionState): Promise<void>;
  clientFileSystemV1(client: V1AgentContext, sessionId: string): ClientFileSystem | undefined;
  clientElicitationV1?(client: V1AgentContext): ClientElicitationCapability | undefined;
  clientToolCallNameV1?(client: V1AgentContext): ClientToolCallNameCapability | undefined;
}

export interface PromptV2Deps extends PromptTurnDeps {
  notifyConfigOptionUpdateV2(client: V2AgentContext, sessionId: string, session: SessionState): Promise<void>;
  clientElicitationV2?(client: V2AgentContext): ClientElicitationCapability | undefined;
  clientToolCallNameV2?(client: V2AgentContext): ClientToolCallNameCapability | undefined;
}

export function parseTurnIntent(params: unknown): TurnIntent | undefined {
  if (!params || typeof params !== "object") return undefined;
  const meta = (params as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const intent = (meta as Record<string, unknown>)["agy-acp/turnIntent"];
  if (intent === "queue" || intent === "steer") return intent;
  return undefined;
}

export function notifyIdleAndDrainQueue(session: SessionState): void {
  const notify = session.promptIdleNotify;
  session.promptIdleNotify = undefined;
  if (notify) {
    notify();
    return;
  }

  if (!session.activePrompt && session.promptQueue.length > 0) {
    const next = session.promptQueue.shift()!;
    if (next.version === "v1") {
      if (next.signal?.aborted) {
        next.resolve({ stopReason: "cancelled" });
        notifyIdleAndDrainQueue(session);
        return;
      }
      void executeQueuedV1Turn(next);
    } else {
      if (next.controller.signal.aborted) {
        void next.client.notify(v2.methods.client.session.update, {
          sessionId: next.params.sessionId,
          update: { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" }
        }).catch(() => {});
        notifyIdleAndDrainQueue(session);
        return;
      }
      void executeQueuedV2Turn(next);
    }
  }
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

/**
 * v1 `session/prompt`: response carries stopReason after the full turn.
 *
 * Zero prompt injection: only client `params.prompt` content is encoded and
 * forwarded to agy. No adapter-authored labels, instructions, or follow-ups.
 */
export async function handlePromptV1(
  params: V1PromptRequest,
  client: V1AgentContext,
  signal: AbortSignal | undefined,
  deps: PromptV1Deps
): Promise<V1PromptResponse> {
  const session = deps.requireSession(params.sessionId);
  if (session.activePrompt) {
    const intent = parseTurnIntent(params);
    if (intent === "queue") {
      return new Promise<V1PromptResponse>((resolve, reject) => {
        const queuedId = `q-${randomUUID()}`;
        const queued: QueuedPromptV1 = {
          id: queuedId,
          version: "v1",
          params,
          client,
          signal,
          deps,
          resolve,
          reject
        };
        session.promptQueue.push(queued);
        if (signal) {
          const onAbort = () => {
            const idx = session.promptQueue.findIndex((q) => q.id === queuedId);
            if (idx >= 0) {
              session.promptQueue.splice(idx, 1);
              resolve({ stopReason: "cancelled" });
            }
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }

    if (intent === "steer") {
      session.promptAbort?.abort();
      await session.agy.cancel();
      if (session.activePrompt) {
        await new Promise<void>((resolve) => {
          const prevNotify = session.promptIdleNotify;
          session.promptIdleNotify = () => {
            prevNotify?.();
            resolve();
          };
        });
      }
    } else {
      throw new Error(`Session already has an active prompt: ${params.sessionId}`);
    }
  }

  const prompt = await contentBlocksToPrompt(params.prompt, session.cwd);

  // Curated slash commands → config options; do not spawn agy for those.
  // Only intercept pure client text blocks (not resource/image payloads whose
  // flattened body happens to look like `/plan`).
  const handled =
    isClientTextSlashPrompt(params.prompt) &&
    (await applyCuratedSlashCommand(
      params.sessionId,
      prompt,
      {
        // ACP transition: send both legacy current_mode_update (modes-API clients)
        // and config_option_update (configOptions clients) on slash-command mode changes.
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
    ));
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
    const tracker = createTerminalOutputTracker();
    const clientToolCallName = deps.clientToolCallNameV1?.(client);
    const outcome = await session.agy.prompt(prompt, async (update) => {
      await client.notify(v1.methods.client.session.update, {
        sessionId: params.sessionId,
        update: sessionUpdateToV1(update, tracker, { clientToolCallName })
      });
    }, async (toolCall, { toolName, questionIndex }) => {
      const elicitationCap = deps.clientElicitationV1?.(client);
      return requestPermissionV1(
        client,
        params.sessionId,
        toolCall,
        toolName,
        signal,
        questionIndex,
        elicitationCap,
        clientToolCallName
      );
    }, deps.clientFileSystemV1(client, params.sessionId), deps.clientElicitationV1?.(client));
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
    notifyIdleAndDrainQueue(session);
  }
}

async function executeQueuedV1Turn(item: QueuedPromptV1): Promise<void> {
  const { params, client, signal, deps, resolve, reject } = item;
  const session = deps.requireSession(params.sessionId);
  session.activePrompt = true;

  try {
    const prompt = await contentBlocksToPrompt(params.prompt, session.cwd);

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
      resolve({ stopReason: signal?.aborted ? "cancelled" : "end_turn" });
      return;
    }

    const cancelPrompt = () => {
      session.agy.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", cancelPrompt, { once: true });

    try {
      const tracker = createTerminalOutputTracker();
      const clientToolCallName = deps.clientToolCallNameV1?.(client);
      const outcome = await session.agy.prompt(prompt, async (update) => {
        await client.notify(v1.methods.client.session.update, {
          sessionId: params.sessionId,
          update: sessionUpdateToV1(update, tracker, { clientToolCallName })
        });
      }, async (toolCall, { toolName, questionIndex }) => {
        const elicitationCap = deps.clientElicitationV1?.(client);
        return requestPermissionV1(
          client,
          params.sessionId,
          toolCall,
          toolName,
          signal,
          questionIndex,
          elicitationCap,
          clientToolCallName
        );
      }, deps.clientFileSystemV1(client, params.sessionId), deps.clientElicitationV1?.(client));
      await deps.persistSession(params.sessionId, session);
      resolve({
        stopReason: outcome.stopReason === "cancelled" || signal?.aborted ? "cancelled" : "end_turn"
      });
    } finally {
      signal?.removeEventListener("abort", cancelPrompt);
    }
  } catch (error) {
    await deps.persistSession(params.sessionId, session).catch(() => {});
    reject(error as Error);
  } finally {
    session.activePrompt = false;
    notifyIdleAndDrainQueue(session);
  }
}

/**
 * v2 `session/prompt`: respond `{}` immediately on acceptance. Foreground
 * progress and stopReason arrive as `state_update` notifications.
 *
 * Zero prompt injection: only client `params.prompt` content is encoded and
 * forwarded to agy. No adapter-authored labels, instructions, or follow-ups.
 */
export async function handlePromptV2(
  params: V2PromptRequest,
  client: V2AgentContext,
  deps: PromptV2Deps
): Promise<V2PromptResponse> {
  const session = deps.requireSession(params.sessionId);
  if (session.activePrompt) {
    const intent = parseTurnIntent(params);
    if (intent === "queue") {
      const promptText = await contentBlocksToPrompt(params.prompt as v1.ContentBlock[], session.cwd);
      const parsedSlash = parseSlashCommand(promptText);
      const slashResult = parsedSlash ? interpretSlashCommand(parsedSlash) : null;
      const userMessageId =
        slashResult && slashResult.kind !== "pass"
          ? `slash-${randomUUID()}`
          : `user-${randomUUID()}`;

      await client.notify(v2.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "user_message",
          messageId: userMessageId,
          content: params.prompt as v2.ContentBlock[]
        }
      });

      const controller = new AbortController();
      const queuedId = `q-${randomUUID()}`;
      const queued: QueuedPromptV2 = {
        id: queuedId,
        version: "v2",
        params,
        client,
        promptText,
        userMessageId,
        controller,
        deps
      };
      session.promptQueue.push(queued);
      if (!session.activePrompt) {
        notifyIdleAndDrainQueue(session);
      }
      return {};
    }

    if (intent === "steer") {
      session.promptAbort?.abort();
      await session.agy.cancel();
      if (session.activePrompt) {
        await new Promise<void>((resolve) => {
          const prevNotify = session.promptIdleNotify;
          session.promptIdleNotify = () => {
            prevNotify?.();
            resolve();
          };
        });
      }
    } else {
      throw new Error(`Session already has an active prompt: ${params.sessionId}`);
    }
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
      notifyIdleAndDrainQueue(session);
    });

  return {};
}

async function executeQueuedV2Turn(item: QueuedPromptV2): Promise<void> {
  const { params, client, promptText, userMessageId, controller, deps } = item;
  const session = deps.requireSession(params.sessionId);
  session.activePrompt = true;
  session.promptAbort = controller;

  const notify = async (update: v2.SessionUpdate) => {
    await client.notify(v2.methods.client.session.update, {
      sessionId: params.sessionId,
      update
    });
  };

  const signal = controller.signal;
  try {
    signal.throwIfAborted();

    // user_message was already sent at enqueue time.
    await notify({ sessionUpdate: "state_update", state: "running" });

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
      const terminalTracker = createTerminalOutputTracker();
      const toolContentTracker = createToolCallContentTracker();
      const clientToolCallName = deps.clientToolCallNameV2?.(client);
      const outcome = await (async () => {
        try {
          return await session.agy.prompt(promptText, async (update) => {
            for (const v2Update of expandSessionUpdateToV2(update, terminalTracker, toolContentTracker, { clientToolCallName })) {
              await notify(v2Update);
            }
          }, async (toolCall, { toolName, questionIndex }) => {
            const elicitationCap = deps.clientElicitationV2?.(client);
            return requestPermissionV2(
              client,
              params.sessionId,
              toolCall,
              toolName,
              signal,
              questionIndex,
              elicitationCap,
              clientToolCallName
            );
          }, undefined, deps.clientElicitationV2?.(client));
        } finally {
          const userStepIdxs = session.agy.lastPromptUserStepIdxs;
          if (userStepIdxs.length > 1) {
            throw new Error(`Expected at most one user step for a prompt, observed: ${userStepIdxs.join(", ")}`);
          }
          if (userStepIdxs.length === 1) {
            session.v2UserMessageIdsByStep[String(userStepIdxs[0])] = userMessageId;
          }
        }
      })();
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
    await notify({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "end_turn"
    });
  } finally {
    if (session.promptAbort === controller) {
      session.promptAbort = undefined;
    }
    session.activePrompt = false;
    notifyIdleAndDrainQueue(session);
  }
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

  // Only treat pure client text as a slash-menu selection (not resource bodies).
  const clientSlash = isClientTextSlashPrompt(params.prompt as v1.ContentBlock[]);
  const parsedSlash = clientSlash ? parseSlashCommand(promptText) : null;
  const slashResult = parsedSlash ? interpretSlashCommand(parsedSlash) : null;
  const userMessageId =
    slashResult && slashResult.kind !== "pass"
      ? `slash-${randomUUID()}`
      : `user-${randomUUID()}`;
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
    const slashHandled =
      clientSlash &&
      (await applyCuratedSlashCommand(
        params.sessionId,
        promptText,
        {
          configChanged: async () => {
            await deps.notifyConfigOptionUpdateV2(client, params.sessionId, deps.requireSession(params.sessionId));
          }
        },
        deps
      ));
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
      const terminalTracker = createTerminalOutputTracker();
      const toolContentTracker = createToolCallContentTracker();
      const clientToolCallName = deps.clientToolCallNameV2?.(client);
      const outcome = await (async () => {
        try {
          return await session.agy.prompt(promptText, async (update) => {
            for (const v2Update of expandSessionUpdateToV2(update, terminalTracker, toolContentTracker, { clientToolCallName })) {
              await notify(v2Update);
            }
          }, async (toolCall, { toolName, questionIndex }) => {
            const elicitationCap = deps.clientElicitationV2?.(client);
            return requestPermissionV2(
              client,
              params.sessionId,
              toolCall,
              toolName,
              signal,
              questionIndex,
              elicitationCap,
              clientToolCallName
            );
          }, undefined, deps.clientElicitationV2?.(client));
        } finally {
          const userStepIdxs = session.agy.lastPromptUserStepIdxs;
          if (userStepIdxs.length > 1) {
            throw new Error(`Expected at most one user step for a prompt, observed: ${userStepIdxs.join(", ")}`);
          }
          if (userStepIdxs.length === 1) {
            session.v2UserMessageIdsByStep[String(userStepIdxs[0])] = userMessageId;
          }
        }
      })();
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
