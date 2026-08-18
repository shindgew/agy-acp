// ACP session/fork: create a new session branching off an existing session's history and configuration.
// Docs: https://agentclientprotocol.com/rfds/session-fork

import type {
  AgentContext as V1AgentContext,
  ForkSessionRequest as V1ForkSessionRequest,
  ForkSessionResponse as V1ForkSessionResponse
} from "@agentclientprotocol/sdk";
import type {
  AgentContext as V2AgentContext,
  ForkSessionRequest as V2ForkSessionRequest,
  ForkSessionResponse as V2ForkSessionResponse
} from "@agentclientprotocol/sdk/experimental/v2";
import { sessionConfigOptionsV1, sessionConfigOptionsV2 } from "./config-options.js";
import { sessionModeState } from "./modes.js";
import { deferAfterResponse } from "./new.js";
import type { SessionState } from "./types.js";

export type { V1ForkSessionRequest, V1ForkSessionResponse, V2ForkSessionRequest, V2ForkSessionResponse };

export interface ForkSessionDeps {
  requireAuthenticated(cwd?: string): Promise<void>;
  forkSession(
    parentSessionId: string,
    cwd: string | undefined,
    additionalDirectories: string[] | undefined
  ): Promise<{ childSession: SessionState; cwd: string; childSessionId: string }>;
}

export async function handleForkSessionV1(
  params: V1ForkSessionRequest,
  client: V1AgentContext | undefined,
  deps: ForkSessionDeps & {
    notifyAvailableCommandsV1(client: V1AgentContext, sessionId: string): Promise<void>;
  }
): Promise<V1ForkSessionResponse> {
  await deps.requireAuthenticated(params.cwd);
  const { childSession, childSessionId } = await deps.forkSession(
    params.sessionId,
    params.cwd,
    params.additionalDirectories
  );
  if (client) {
    childSession.v1Client = client;
    deferAfterResponse(() => deps.notifyAvailableCommandsV1(client, childSessionId));
  }
  return {
    sessionId: childSessionId,
    modes: sessionModeState(childSession.agy.config.mode),
    configOptions: sessionConfigOptionsV1(childSession)
  };
}

export async function handleForkSessionV2(
  params: V2ForkSessionRequest,
  client: V2AgentContext | undefined,
  deps: ForkSessionDeps & {
    notifyAvailableCommandsV2(client: V2AgentContext, sessionId: string): Promise<void>;
  }
): Promise<V2ForkSessionResponse> {
  await deps.requireAuthenticated(params.cwd);
  const { childSession, childSessionId } = await deps.forkSession(
    params.sessionId,
    params.cwd,
    params.additionalDirectories
  );
  if (client) {
    childSession.v2Client = client;
    deferAfterResponse(() => deps.notifyAvailableCommandsV2(client, childSessionId));
  }
  return {
    sessionId: childSessionId,
    configOptions: sessionConfigOptionsV2(childSession)
  };
}
