import { describe, expect, it } from "vitest";
import { handleInitializeV1, handleInitializeV2 } from "../src/acp/initialize.js";
import { handleMcpMessage, handleMcpConnect, handleMcpDisconnect } from "../src/acp/mcp/index.js";

describe("MCP over ACP (Issue #36)", () => {
  it("does not advertise MCP transports until the bridge is implemented (v1)", () => {
    const { response } = handleInitializeV1(
      { protocolVersion: 1, clientCapabilities: {} },
      "1.0.0"
    );
    expect(response.agentCapabilities?.mcpCapabilities).toEqual({
      http: false,
      sse: false,
      acp: false
    });
  });

  it("does not advertise MCP transports until the bridge is implemented (v2)", () => {
    const { response } = handleInitializeV2(
      {
        protocolVersion: 2,
        info: { name: "test-client", version: "0.0.0" }
      },
      "1.0.0"
    );
    expect(response.capabilities?.session).not.toHaveProperty("mcp");
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
