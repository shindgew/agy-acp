// ACP Client-Executed Terminals: agent-to-client RPC method callers.
// Enables the agent to request terminal creation, output retrieval, exit waiting,
// and process killing from client editors that support the `terminal/*` RPC suite.
// Docs: https://agentclientprotocol.com/protocol/v1/terminals

import type { AgentContext as V1AgentContext } from "@agentclientprotocol/sdk";
import type { AgentContext as V2AgentContext } from "@agentclientprotocol/sdk/experimental/v2";

export type AcpClientContext = V1AgentContext | V2AgentContext;

export interface CreateTerminalParams {
  sessionId: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  outputLimit?: number;
}

export interface CreateTerminalResult {
  terminalId: string;
}

export interface TerminalOutputParams {
  sessionId: string;
  terminalId: string;
}

export interface TerminalOutputResult {
  output: string;
  truncated?: boolean;
}

export interface TerminalReleaseParams {
  sessionId: string;
  terminalId: string;
}

export interface TerminalWaitForExitParams {
  sessionId: string;
  terminalId: string;
  timeoutMs?: number;
}

export interface TerminalWaitForExitResult {
  exitCode?: number | null;
  signal?: string;
}

export interface TerminalKillParams {
  sessionId: string;
  terminalId: string;
}

/**
 * ACP `terminal/create` client RPC call:
 * Request the client editor to create a new terminal instance to execute a command.
 */
export async function createTerminal(
  client: AcpClientContext,
  params: CreateTerminalParams
): Promise<CreateTerminalResult> {
  return await client.request("terminal/create", params as unknown as Record<string, unknown>);
}

/**
 * ACP `terminal/output` client RPC call:
 * Retrieve accumulated output from a client-managed terminal instance.
 */
export async function getTerminalOutput(
  client: AcpClientContext,
  params: TerminalOutputParams
): Promise<TerminalOutputResult> {
  return await client.request("terminal/output", params as unknown as Record<string, unknown>);
}

/**
 * ACP `terminal/release` client RPC call:
 * Release resources associated with a client-managed terminal instance.
 */
export async function releaseTerminal(
  client: AcpClientContext,
  params: TerminalReleaseParams
): Promise<Record<string, unknown>> {
  return await client.request("terminal/release", params as unknown as Record<string, unknown>);
}

/**
 * ACP `terminal/wait_for_exit` client RPC call:
 * Wait for a client-managed terminal process to exit or until optional timeout expires.
 */
export async function waitForTerminalExit(
  client: AcpClientContext,
  params: TerminalWaitForExitParams
): Promise<TerminalWaitForExitResult> {
  return await client.request("terminal/wait_for_exit", params as unknown as Record<string, unknown>);
}

/**
 * ACP `terminal/kill` client RPC call:
 * Terminate a running client-managed terminal process.
 */
export async function killTerminal(
  client: AcpClientContext,
  params: TerminalKillParams
): Promise<Record<string, unknown>> {
  return await client.request("terminal/kill", params as unknown as Record<string, unknown>);
}
