import { describe, expect, it, vi } from "vitest";
import {
  parseClientTerminal,
  handleInitializeV1,
  handleInitializeV2
} from "../src/acp/initialize.js";
import {
  createTerminal,
  getTerminalOutput,
  releaseTerminal,
  waitForTerminalExit,
  killTerminal,
  executeClientTerminal,
  type AcpClientContext
} from "../src/acp/terminal/index.js";

describe("ACP Client Terminal RPC suite (terminal/*)", () => {
  describe("Client terminal capability parsing & advertising", () => {
    it("parses empty or missing terminal capability as create: false", () => {
      expect(parseClientTerminal(null)).toEqual({ create: false });
      expect(parseClientTerminal({})).toEqual({ create: false });
      expect(parseClientTerminal({ clientCapabilities: {} })).toEqual({ create: false });
    });

    it("parses boolean terminal capability", () => {
      expect(parseClientTerminal({ clientCapabilities: { terminal: true } })).toEqual({ create: true });
      expect(parseClientTerminal({ clientCapabilities: { terminal: false } })).toEqual({ create: false });
    });

    it("parses object terminal capability", () => {
      expect(parseClientTerminal({ clientCapabilities: { terminal: {} } })).toEqual({ create: true });
      expect(parseClientTerminal({ clientCapabilities: { terminal: { create: true } } })).toEqual({ create: true });
      expect(parseClientTerminal({ clientCapabilities: { terminal: { create: false } } })).toEqual({ create: false });
    });

    it("parses clientTerminal capability in v1 initialize response without polluting agentCapabilities schema", () => {
      const { response, clientTerminal } = handleInitializeV1(
        {
          protocolVersion: 1,
          clientCapabilities: { terminal: { create: true } }
        } as unknown as Parameters<typeof handleInitializeV1>[0],
        "1.0.0"
      );

      expect(clientTerminal).toEqual({ create: true });
      expect((response.agentCapabilities as unknown as Record<string, unknown>).terminal).toBeUndefined();
    });

    it("advertises terminal capability in v2 initialize response", () => {
      const { response, clientTerminal } = handleInitializeV2(
        {
          protocolVersion: 2,
          capabilities: { terminal: true }
        } as unknown as Parameters<typeof handleInitializeV2>[0],
        "1.0.0"
      );

      expect(clientTerminal).toEqual({ create: true });
      expect((response.capabilities as unknown as Record<string, unknown>).terminal).toEqual({});
    });
  });

  describe("Client terminal RPC callers", () => {
    it("createTerminal calls terminal/create with outputByteLimit and array env wire format", async () => {
      const requestMock = vi.fn().mockResolvedValue({ terminalId: "term-123" });
      const client = { request: requestMock } as unknown as AcpClientContext;

      const result = await createTerminal(client, {
        sessionId: "sess-1",
        command: "npm",
        args: ["test"],
        cwd: "/app",
        env: { NODE_ENV: "test" },
        outputLimit: 4096
      });

      expect(result).toEqual({ terminalId: "term-123" });
      expect(requestMock).toHaveBeenCalledWith("terminal/create", {
        sessionId: "sess-1",
        command: "npm",
        args: ["test"],
        cwd: "/app",
        env: [{ name: "NODE_ENV", value: "test" }],
        outputByteLimit: 4096
      });
    });

    it("getTerminalOutput calls terminal/output via client.request", async () => {
      const requestMock = vi.fn().mockResolvedValue({ output: "hello world\n", truncated: false });
      const client = { request: requestMock } as unknown as AcpClientContext;

      const result = await getTerminalOutput(client, {
        sessionId: "sess-1",
        terminalId: "term-123"
      });

      expect(result).toEqual({ output: "hello world\n", truncated: false });
      expect(requestMock).toHaveBeenCalledWith("terminal/output", {
        sessionId: "sess-1",
        terminalId: "term-123"
      });
    });

    it("releaseTerminal calls terminal/release via client.request", async () => {
      const requestMock = vi.fn().mockResolvedValue({});
      const client = { request: requestMock } as unknown as AcpClientContext;

      const result = await releaseTerminal(client, {
        sessionId: "sess-1",
        terminalId: "term-123"
      });

      expect(result).toEqual({});
      expect(requestMock).toHaveBeenCalledWith("terminal/release", {
        sessionId: "sess-1",
        terminalId: "term-123"
      });
    });

    it("waitForTerminalExit calls terminal/wait_for_exit via client.request", async () => {
      const requestMock = vi.fn().mockResolvedValue({ exitCode: 0 });
      const client = { request: requestMock } as unknown as AcpClientContext;

      const result = await waitForTerminalExit(client, {
        sessionId: "sess-1",
        terminalId: "term-123",
        timeoutMs: 5000
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(requestMock).toHaveBeenCalledWith("terminal/wait_for_exit", {
        sessionId: "sess-1",
        terminalId: "term-123",
        timeoutMs: 5000
      });
    });

    it("killTerminal calls terminal/kill via client.request", async () => {
      const requestMock = vi.fn().mockResolvedValue({});
      const client = { request: requestMock } as unknown as AcpClientContext;

      const result = await killTerminal(client, {
        sessionId: "sess-1",
        terminalId: "term-123"
      });

      expect(result).toEqual({});
      expect(requestMock).toHaveBeenCalledWith("terminal/kill", {
        sessionId: "sess-1",
        terminalId: "term-123"
      });
    });

    it("executeClientTerminal orchestrates create -> wait_for_exit -> output -> release lifecycle", async () => {
      const requestMock = vi.fn().mockImplementation((method: string) => {
        if (method === "terminal/create") return Promise.resolve({ terminalId: "term-flow-1" });
        if (method === "terminal/wait_for_exit") return Promise.resolve({ exitCode: 0 });
        if (method === "terminal/output") return Promise.resolve({ output: "flow success", truncated: false });
        if (method === "terminal/release") return Promise.resolve({});
        return Promise.reject(new Error(`Unexpected method: ${method}`));
      });
      const client = { request: requestMock } as unknown as AcpClientContext;

      const result = await executeClientTerminal(client, {
        sessionId: "sess-1",
        command: "ls",
        args: ["-la"]
      });

      expect(result).toEqual({
        terminalId: "term-flow-1",
        exitCode: 0,
        signal: undefined,
        output: "flow success",
        truncated: false
      });

      expect(requestMock).toHaveBeenNthCalledWith(1, "terminal/create", {
        sessionId: "sess-1",
        command: "ls",
        args: ["-la"]
      });
      expect(requestMock).toHaveBeenNthCalledWith(2, "terminal/wait_for_exit", {
        sessionId: "sess-1",
        terminalId: "term-flow-1",
        timeoutMs: undefined
      });
      expect(requestMock).toHaveBeenNthCalledWith(3, "terminal/output", {
        sessionId: "sess-1",
        terminalId: "term-flow-1"
      });
      expect(requestMock).toHaveBeenNthCalledWith(4, "terminal/release", {
        sessionId: "sess-1",
        terminalId: "term-flow-1"
      });
    });
  });
});
