// ACP MCP RPC handlers for mcp/message, mcp/connect, and mcp/disconnect.
// Docs: https://agentclientprotocol.com/rfds/mcp-over-acp

import type { SessionState } from "../session/types.js";

export interface McpRequestParams {
  sessionId?: string;
  name?: string;
  message?: unknown;
  [key: string]: unknown;
}

export interface McpResponse {
  [key: string]: unknown;
}

export interface McpDeps {
  requireSession(sessionId: string): SessionState | Promise<SessionState>;
}

export async function handleMcpMessage(
  params: McpRequestParams,
  deps: McpDeps
): Promise<McpResponse> {
  if (params.sessionId) {
    await deps.requireSession(params.sessionId);
  }
  return { status: "received" };
}

export async function handleMcpConnect(
  params: McpRequestParams,
  deps: McpDeps
): Promise<McpResponse> {
  if (params.sessionId) {
    await deps.requireSession(params.sessionId);
  }
  return { status: "connected" };
}

export async function handleMcpDisconnect(
  params: McpRequestParams,
  deps: McpDeps
): Promise<McpResponse> {
  if (params.sessionId) {
    await deps.requireSession(params.sessionId);
  }
  return { status: "disconnected" };
}
