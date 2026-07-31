import { describe, expect, it } from "vitest";
import { handleInitializeV1, handleInitializeV2 } from "../src/acp/initialize.js";
import { handleMcpMessage, handleMcpConnect, handleMcpDisconnect } from "../src/acp/mcp/index.js";

describe("MCP over ACP (Issue #36)", () => {
  it("advertises MCP capabilities in initialize responses (v1)", () => {
    const { response } = handleInitializeV1(
      { protocolVersion: 1, clientCapabilities: {} },
      "1.0.0"
    );
    expect(response.agentCapabilities.mcpCapabilities).toEqual({
      http: true,
      sse: true,
      acp: true
    });
  });

  it("advertises MCP capabilities in initialize responses (v2)", () => {
    const { response } = handleInitializeV2(
      { protocolVersion: 2 },
      "1.0.0"
    );
    expect(response.capabilities.session.mcp).toEqual({});
  });

  it("handles mcp/message, mcp/connect, and mcp/disconnect RPC calls", async () => {
    const mockDeps = {
      requireSession: async (_id: string) => ({} as any)
    };

    const msgRes = await handleMcpMessage({ sessionId: "test-session", message: { ping: true } }, mockDeps);
    expect(msgRes).toEqual({ status: "received" });

    const connRes = await handleMcpConnect({ sessionId: "test-session", name: "server1" }, mockDeps);
    expect(connRes).toEqual({ status: "connected" });

    const disconnRes = await handleMcpDisconnect({ sessionId: "test-session", name: "server1" }, mockDeps);
    expect(disconnRes).toEqual({ status: "disconnected" });
  });
});
