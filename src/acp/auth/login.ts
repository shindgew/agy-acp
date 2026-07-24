// ACP authentication login handlers (v1 authenticate & v2 auth/login).
// Docs: https://agentclientprotocol.com/protocol/v1/authentication

import { RequestError } from "@agentclientprotocol/sdk";
import type { AuthenticateRequest, AuthenticateResponse } from "@agentclientprotocol/sdk";
import type { LoginAuthRequest, LoginAuthResponse } from "@agentclientprotocol/sdk/experimental/v2";
import { AUTH_REQUIRED_MESSAGE, isAgyAuthenticated, isKnownAuthMethodId, v1AuthMethods } from "../../agy/auth.js";
import type { AgyCliBackend, AgyCliConfig } from "../../agy/cli.js";

export async function handleAuthenticate(
  params: AuthenticateRequest,
  backend: AgyCliBackend,
  config: AgyCliConfig,
  ensureAgyReady: () => Promise<string | null>
): Promise<AuthenticateResponse> {
  await ensureAgyReady();
  if (!isKnownAuthMethodId(params.methodId)) {
    throw RequestError.invalidParams({ methodId: params.methodId }, `Unknown auth method: ${params.methodId}`);
  }
  const status = await isAgyAuthenticated(backend, config);
  if (status.ok) return {};
  console.error(`[agy-acp] auth required: ${status.reason}`);
  throw RequestError.authRequired({ authMethods: v1AuthMethods() }, AUTH_REQUIRED_MESSAGE);
}

export async function handleLoginAuth(
  params: LoginAuthRequest,
  backend: AgyCliBackend,
  config: AgyCliConfig,
  ensureAgyReady: () => Promise<string | null>
): Promise<LoginAuthResponse> {
  return handleAuthenticate({ methodId: params.methodId }, backend, config, ensureAgyReady);
}
