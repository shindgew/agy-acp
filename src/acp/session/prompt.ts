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

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function notifyV2BestEffort(
  client: V2AgentContext,
  sessionId: string,
  update: v2.SessionUpdate
): void {
  try {
    void client.notify(v2.methods.client.session.update, { sessionId, update }).catch(() => {});
  } catch {
    // Teardown must not wait for or fail on a disconnected client transport.
  }
}

/** True when a turn is running or a steer has reserved the next turn. */
export function sessionTurnBusy(session: SessionState): boolean {
  return session.activePrompt || (session.steerClaims ?? 0) > 0;
}

export function notifyIdleAndDrainQueue(session: SessionState): void {
  const notify = session.promptIdleNotify;
  session.promptIdleNotify = undefined;
  if (notify) {
    notify();
    return;
  }

  if (session.closed) return;
  // A steer has reserved the next turn (possibly still waiting on a prior steer).
  if ((session.steerClaims ?? 0) > 0) return;

  if (!session.activePrompt && session.promptQueue.length > 0) {
    const next = session.promptQueue.shift()!;
    if (next.version === "v1") {
      if (next.signal?.aborted) {
        next.resolve({ stopReason: "cancelled" });
        notifyIdleAndDrainQueue(session);
        return;
      }
      void executeQueuedV1Turn(next).catch((error) => {
        console.error(`[agy-acp] queued v1 turn failed: ${(error as Error).message}`);
      });
    } else {
      if (next.controller.signal.aborted) {
        void next.client.notify(v2.methods.client.session.update, {
          sessionId: next.params.sessionId,
          update: { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" }
        }).catch(() => {});
        notifyIdleAndDrainQueue(session);
        return;
      }
      void executeQueuedV2Turn(next).catch((error) => {
        console.error(`[agy-acp] queued v2 turn failed: ${(error as Error).message}`);
      });
    }
  }
}

/**
 * Claim the session for a steer replacement before any await, then serialize
 * against other steers. The returned release must run exactly once (success,
 * cancel, or closed) so the queue can drain again.
 */
async function acquireSteerSlot(session: SessionState): Promise<() => void> {
  session.steerClaims = (session.steerClaims ?? 0) + 1;
  const previousSteer = session.promptSteerInProgress;
  let release!: () => void;
  session.promptSteerInProgress = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (previousSteer) await previousSteer;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    session.steerClaims = Math.max(0, (session.steerClaims ?? 1) - 1);
    release();
  };
}

/** Wake any steer idle-waiter after marking the session closed. */
export function wakePromptIdleWaiters(session: SessionState): void {
  const notify = session.promptIdleNotify;
  session.promptIdleNotify = undefined;
  notify?.();
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
  const busyAtAdmission = sessionTurnBusy(session);
  if (busyAtAdmission) {
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
          if (signal.aborted) onAbort();
        }
      });
    }
    if (intent !== "steer") {
      throw new Error(`Session already has an active prompt: ${params.sessionId}`);
    }
  }

  // Own the steer claim (if any) for the full replacement path — including
  // setup failures and slash-only turns — so release + queue drain always run.
  let releaseSteer: (() => void) | undefined;
  let ownsActivePrompt = false;
  let turnController: AbortController | undefined;
  const cancelled = () => Boolean(
    signal?.aborted || turnController?.signal.aborted || session.closed
  );
  if (!busyAtAdmission) {
    // Claim an idle session before attachment conversion or config awaits.
    session.activePrompt = true;
    ownsActivePrompt = true;
    turnController = new AbortController();
    session.promptAbort = turnController;
  }
  try {
    if (busyAtAdmission) {
      // Reserve before any await so a queued follow-up cannot claim the session.
      releaseSteer = await acquireSteerSlot(session);
      // Teardown may have completed while this steer waited behind another.
      if (cancelled()) {
        return { stopReason: "cancelled" };
      }
      const waitForIdle = session.activePrompt
        ? new Promise<void>((resolve) => {
            const prevNotify = session.promptIdleNotify;
            session.promptIdleNotify = () => {
              prevNotify?.();
              resolve();
            };
          })
        : undefined;
      session.promptAbort?.abort();
      await session.agy.cancel();
      await waitForIdle;
      // Request may have been cancelled while waiting on the prior turn/steer.
      if (cancelled()) {
        return { stopReason: "cancelled" };
      }
      session.activePrompt = true;
      ownsActivePrompt = true;
      turnController = new AbortController();
      session.promptAbort = turnController;
    }

    const prompt = await contentBlocksToPrompt(params.prompt, session.cwd);
    if (cancelled()) {
      return { stopReason: "cancelled" };
    }

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
      return { stopReason: cancelled() ? "cancelled" : "end_turn" };
    }

    if (cancelled()) {
      return { stopReason: "cancelled" };
    }

    const cancelPrompt = () => {
      session.agy.cancel().catch(() => {
        // The prompt loop will surface process failures through its own result.
      });
    };
    signal?.addEventListener("abort", cancelPrompt, { once: true });
    turnController?.signal.addEventListener("abort", cancelPrompt, { once: true });
    // Listener only fires for future aborts; honor an already-aborted signal.
    if (cancelled()) {
      signal?.removeEventListener("abort", cancelPrompt);
      turnController?.signal.removeEventListener("abort", cancelPrompt);
      return { stopReason: "cancelled" };
    }

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
      if (!session.closed) {
        await deps.persistSession(params.sessionId, session);
      }
      return {
        stopReason: outcome.stopReason === "cancelled" || cancelled() ? "cancelled" : "end_turn"
      };
    } catch (error) {
      // Persist even on failure: agy's conversation id/step position may have
      // advanced before it errored out, and that partial progress is worth
      // resuming from on the next prompt.
      if (!cancelled()) {
        await deps.persistSession(params.sessionId, session).catch(() => {});
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancelPrompt);
      turnController?.signal.removeEventListener("abort", cancelPrompt);
    }
  } finally {
    if (turnController && session.promptAbort === turnController) {
      session.promptAbort = undefined;
    }
    if (ownsActivePrompt) {
      session.activePrompt = false;
    }
    releaseSteer?.();
    // Slash-only, closed, setup-error, and agy paths all release the same
    // admission claim here, after which queued work may proceed.
    if (!session.activePrompt) {
      notifyIdleAndDrainQueue(session);
    }
  }
}

async function executeQueuedV1Turn(item: QueuedPromptV1): Promise<void> {
  const { params, client, signal, deps, resolve, reject } = item;
  const session = deps.requireSession(params.sessionId);
  session.activePrompt = true;
  const turnController = new AbortController();
  session.promptAbort = turnController;

  const cancelled = () => Boolean(
    signal?.aborted || turnController.signal.aborted || session.closed
  );

  try {
    if (cancelled()) {
      resolve({ stopReason: "cancelled" });
      return;
    }

    const prompt = await contentBlocksToPrompt(params.prompt, session.cwd);
    if (cancelled()) {
      resolve({ stopReason: "cancelled" });
      return;
    }

    const handled =
      isClientTextSlashPrompt(params.prompt) &&
      (await applyCuratedSlashCommand(
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
      ));
    if (handled) {
      resolve({ stopReason: cancelled() ? "cancelled" : "end_turn" });
      return;
    }

    if (cancelled()) {
      resolve({ stopReason: "cancelled" });
      return;
    }

    const cancelPrompt = () => {
      session.agy.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", cancelPrompt, { once: true });
    turnController.signal.addEventListener("abort", cancelPrompt, { once: true });
    // Listener only fires for future aborts; honor an already-aborted signal.
    if (cancelled()) {
      signal?.removeEventListener("abort", cancelPrompt);
      turnController.signal.removeEventListener("abort", cancelPrompt);
      cancelPrompt();
      resolve({ stopReason: "cancelled" });
      return;
    }

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
      if (!session.closed) {
        await deps.persistSession(params.sessionId, session);
      }
      resolve({
        stopReason:
          outcome.stopReason === "cancelled" || cancelled() ? "cancelled" : "end_turn"
      });
    } finally {
      signal?.removeEventListener("abort", cancelPrompt);
      turnController.signal.removeEventListener("abort", cancelPrompt);
    }
  } catch (error) {
    if (!cancelled()) {
      await deps.persistSession(params.sessionId, session).catch(() => {});
    }
    if (cancelled()) {
      resolve({ stopReason: "cancelled" });
      return;
    }
    reject(error as Error);
  } finally {
    if (session.promptAbort === turnController) {
      session.promptAbort = undefined;
    }
    session.activePrompt = false;
    notifyIdleAndDrainQueue(session);
  }
}

async function runSteeredV2Turn(
  params: V2PromptRequest,
  client: V2AgentContext,
  session: SessionState,
  steerSlot: Promise<() => void>,
  deps: PromptV2Deps
): Promise<void> {
  const releaseSteer = await steerSlot;
  let ownsActivePrompt = false;
  let controller: AbortController | undefined;
  try {
    if (session.closed) {
      notifyV2BestEffort(client, params.sessionId, {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled"
      });
      return;
    }

    const waitForIdle = session.activePrompt
      ? new Promise<void>((resolve) => {
          const prevNotify = session.promptIdleNotify;
          session.promptIdleNotify = () => {
            prevNotify?.();
            resolve();
          };
        })
      : undefined;
    session.promptAbort?.abort();
    await session.agy.cancel();
    await waitForIdle;
    if (session.closed) {
      notifyV2BestEffort(client, params.sessionId, {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled"
      });
      return;
    }

    session.activePrompt = true;
    ownsActivePrompt = true;
    const promptText = await contentBlocksToPrompt(
      params.prompt as v1.ContentBlock[],
      session.cwd
    );
    if (session.closed) {
      notifyV2BestEffort(client, params.sessionId, {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled"
      });
      return;
    }

    controller = new AbortController();
    session.promptAbort = controller;
    await runV2PromptTurn(params, client, session, promptText, controller.signal, deps);
  } finally {
    if (controller && session.promptAbort === controller) {
      session.promptAbort = undefined;
    }
    if (ownsActivePrompt) {
      session.activePrompt = false;
    }
    releaseSteer();
    if (!session.activePrompt) {
      notifyIdleAndDrainQueue(session);
    }
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
  const busyAtAdmission = sessionTurnBusy(session);
  if (busyAtAdmission) {
    const intent = parseTurnIntent(params);
    if (intent === "queue") {
      const controller = new AbortController();
      const queuedId = `q-${randomUUID()}`;
      const queued: QueuedPromptV2 = {
        id: queuedId,
        version: "v2",
        params,
        client,
        ready: Promise.resolve(),
        controller,
        deps
      };
      // Enter FIFO before conversion or client transport awaits can reorder
      // concurrently admitted queue requests.
      session.promptQueue.push(queued);
      const responseQueued = new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      const previousPreparation = session.promptQueuePreparation ?? Promise.resolve();
      queued.ready = raceWithAbort(
        previousPreparation.catch(() => {}).then(() => responseQueued).then(async () => {
          const promptText = await contentBlocksToPrompt(
            params.prompt as v1.ContentBlock[],
            session.cwd
          );
          controller.signal.throwIfAborted();
          const parsedSlash = isClientTextSlashPrompt(params.prompt as v1.ContentBlock[])
            ? parseSlashCommand(promptText)
            : null;
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
          controller.signal.throwIfAborted();
          queued.promptText = promptText;
          queued.userMessageId = userMessageId;
        }),
        controller.signal
      );
      session.promptQueuePreparation = queued.ready.then(() => {}, () => {});
      void queued.ready.catch(() => {
        const idx = session.promptQueue.findIndex((item) => item.id === queuedId);
        if (idx < 0) return; // The FIFO executor owns terminal reporting.
        session.promptQueue.splice(idx, 1);
        if (!controller.signal.aborted && !session.closed) {
          notifyV2BestEffort(client, params.sessionId, {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn"
          });
        }
        if (!sessionTurnBusy(session)) notifyIdleAndDrainQueue(session);
      });
      if (!sessionTurnBusy(session)) {
        notifyIdleAndDrainQueue(session);
      }
      return {};
    }
    if (intent !== "steer") {
      throw new Error(`Session already has an active prompt: ${params.sessionId}`);
    }
    // Reserve synchronously, acknowledge the RPC, then cancel and replace on
    // the next task so backend shutdown latency cannot delay v2 acceptance.
    const steerSlot = acquireSteerSlot(session);
    const responseQueued = new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    void responseQueued
      .then(() => runSteeredV2Turn(params, client, session, steerSlot, deps))
      .catch((error) => {
        console.error(`[agy-acp] v2 steer turn failed: ${(error as Error).message}`);
      });
    return {};
  }

  // Claim an idle session before attachment conversion. Once scheduled, the
  // detached turn owns this claim and releases it from its finalizer.
  session.activePrompt = true;
  let turnScheduled = false;
  try {
    // Content block shapes are compatible at runtime; v1/v2 TS types diverge on open enums.
    const promptText = await contentBlocksToPrompt(params.prompt as v1.ContentBlock[], session.cwd);
    if (session.closed) {
      notifyV2BestEffort(client, params.sessionId, {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled"
      });
      return {};
    }
    const controller = new AbortController();
    session.promptAbort = controller;

    // Queue the empty acceptance response before any session/update from the turn.
    // Work starts on the next event-loop task (see dual-version-agent example).
    const responseQueued = new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    turnScheduled = true;

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
  } finally {
    // Setup failed or closed before the async turn was scheduled.
    if (!turnScheduled) {
      session.activePrompt = false;
      notifyIdleAndDrainQueue(session);
    }
  }
}

async function executeQueuedV2Turn(item: QueuedPromptV2): Promise<void> {
  const { params, client, controller, deps } = item;
  const session = deps.requireSession(params.sessionId);
  session.activePrompt = true;
  session.promptAbort = controller;
  const signal = controller.signal;

  const notify = async (update: v2.SessionUpdate) => {
    await raceWithAbort(
      client.notify(v2.methods.client.session.update, {
        sessionId: params.sessionId,
        update
      }),
      signal
    );
  };

  try {
    signal.throwIfAborted();
    await item.ready;
    signal.throwIfAborted();
    const { promptText, userMessageId } = item;
    if (promptText === undefined || userMessageId === undefined) {
      throw new Error("Queued v2 prompt preparation completed without content");
    }

    // user_message was already sent at enqueue time.
    await notify({ sessionUpdate: "state_update", state: "running" });
    // Cleanup may have aborted while the notification was in flight.
    signal.throwIfAborted();
    if (session.closed) {
      notifyV2BestEffort(client, params.sessionId, {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled"
      });
      return;
    }

    const slashHandled =
      isClientTextSlashPrompt(params.prompt as v1.ContentBlock[]) &&
      (await applyCuratedSlashCommand(
        params.sessionId,
        promptText,
        {
          configChanged: () => raceWithAbort(
            deps.notifyConfigOptionUpdateV2(
              client,
              params.sessionId,
              deps.requireSession(params.sessionId)
            ),
            signal
          )
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

    signal.throwIfAborted();
    if (session.closed) {
      notifyV2BestEffort(client, params.sessionId, {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled"
      });
      return;
    }

    const cancelPrompt = () => {
      session.agy.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancelPrompt, { once: true });
    // Listener only fires for future aborts; honor an already-aborted signal.
    if (signal.aborted) {
      cancelPrompt();
      signal.throwIfAborted();
    }

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
      if (!session.closed) {
        await deps.persistSession(params.sessionId, session);
      }

      const stopReason =
        outcome.stopReason === "cancelled" || signal.aborted || session.closed ? "cancelled" : "end_turn";
      await notify({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason
      });
    } finally {
      signal.removeEventListener("abort", cancelPrompt);
    }
  } catch (error) {
    if (!session.closed && !signal.aborted) {
      await deps.persistSession(params.sessionId, session).catch(() => {});
    }
    if (signal.aborted || session.closed) {
      notifyV2BestEffort(client, params.sessionId, {
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
    await raceWithAbort(
      client.notify(v2.methods.client.session.update, {
        sessionId: params.sessionId,
        update
      }),
      signal
    );
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
    signal.throwIfAborted();
    if (session.closed) {
      notifyV2BestEffort(client, params.sessionId, {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled"
      });
      return;
    }

    // Curated slash commands → config options (no agy spawn).
    const slashHandled =
      clientSlash &&
      (await applyCuratedSlashCommand(
        params.sessionId,
        promptText,
        {
          configChanged: () => raceWithAbort(
            deps.notifyConfigOptionUpdateV2(
              client,
              params.sessionId,
              deps.requireSession(params.sessionId)
            ),
            signal
          )
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

    signal.throwIfAborted();
    if (session.closed) {
      notifyV2BestEffort(client, params.sessionId, {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled"
      });
      return;
    }

    const cancelPrompt = () => {
      session.agy.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancelPrompt, { once: true });
    if (signal.aborted) {
      cancelPrompt();
      signal.throwIfAborted();
    }

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
      if (!session.closed) {
        await deps.persistSession(params.sessionId, session);
      }

      const stopReason =
        outcome.stopReason === "cancelled" || signal.aborted || session.closed ? "cancelled" : "end_turn";
      await notify({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason
      });
    } finally {
      signal.removeEventListener("abort", cancelPrompt);
    }
  } catch (error) {
    if (!session.closed && !signal.aborted) {
      await deps.persistSession(params.sessionId, session).catch(() => {});
    }
    if (signal.aborted || session.closed) {
      notifyV2BestEffort(client, params.sessionId, {
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
