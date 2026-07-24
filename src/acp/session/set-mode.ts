// ACP session/set_mode: mirrors the `mode` config option onto agy `--mode`.
// Pushes `config_option_update` so clients that only watch config options stay
// aligned (set_mode is outside set_config_option).
// Docs: https://agentclientprotocol.com/protocol/v1/session-modes#setting-the-current-mode

import type {
  AgentContext as V1AgentContext,
  SetSessionModeRequest,
  SetSessionModeResponse
} from "@agentclientprotocol/sdk";
import type { SessionModeId } from "../../agy/cli.js";
import { MODE_CONFIG_ID } from "./modes.js";
import type { SessionState } from "./types.js";

export interface SetSessionModeDeps {
  requireSession(sessionId: string): SessionState;
  applyConfigOption(sessionId: string, configId: string, value: unknown): Promise<void>;
  notifyCurrentModeUpdate(client: V1AgentContext, sessionId: string, mode: SessionModeId): Promise<void>;
  notifyConfigOptionUpdateV1(client: V1AgentContext, sessionId: string, session: SessionState): Promise<void>;
}

export async function handleSetSessionMode(
  params: SetSessionModeRequest,
  client: V1AgentContext,
  deps: SetSessionModeDeps
): Promise<SetSessionModeResponse> {
  const previousMode = deps.requireSession(params.sessionId).agy.config.mode;
  await deps.applyConfigOption(params.sessionId, MODE_CONFIG_ID, params.modeId);
  const session = deps.requireSession(params.sessionId);
  const mode = session.agy.config.mode;

  if (mode !== previousMode) {
    await deps.notifyCurrentModeUpdate(client, params.sessionId, mode);
    await deps.notifyConfigOptionUpdateV1(client, params.sessionId, session);
  }

  return {};
}
