// ACP `initialize` handshake: negotiate protocol version and advertise capabilities.
// Docs: https://agentclientprotocol.com/protocol/v1/initialization

import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import type {
  InitializeRequest as V1InitializeRequest,
  InitializeResponse as V1InitializeResponse
} from "@agentclientprotocol/sdk";
import type {
  InitializeRequest as V2InitializeRequest,
  InitializeResponse as V2InitializeResponse
} from "@agentclientprotocol/sdk/experimental/v2";
import { v1AuthMethods, v2AuthMethods } from "../agy/auth.js";

const AGENT_INFO = { name: "agy-acp", title: "Google Antigravity CLI" };

import type { ClientElicitationCapability } from "./tool-calls/elicitation.js";
export type { ClientElicitationCapability };

export interface ClientFsCapability {
  readTextFile: boolean;
  writeTextFile: boolean;
}

export interface ClientTerminalCapability {
  create: boolean;
}

export function parseClientTerminal(rawCaps: unknown): ClientTerminalCapability {
  if (!rawCaps || typeof rawCaps !== "object") return { create: false };
  const caps = rawCaps as Record<string, unknown>;
  const terminal =
    caps.terminal ??
    (caps.clientCapabilities as Record<string, unknown> | undefined)?.terminal ??
    (caps.capabilities as Record<string, unknown> | undefined)?.terminal;
  if (!terminal) return { create: false };
  if (typeof terminal === "boolean") return { create: terminal };
  if (typeof terminal === "object") {
    const createObj = (terminal as Record<string, unknown>).create;
    const create = createObj != null ? Boolean(createObj) : true;
    return { create };
  }
  return { create: false };
}

function parseClientElicitation(rawCaps: unknown): ClientElicitationCapability {
  if (!rawCaps || typeof rawCaps !== "object") return { form: false, url: false };
  const caps = rawCaps as Record<string, unknown>;
  const elicitation = (caps.elicitation ?? (caps.clientCapabilities as Record<string, unknown> | undefined)?.elicitation ?? (caps.capabilities as Record<string, unknown> | undefined)?.elicitation) as Record<string, unknown> | undefined;
  if (!elicitation || typeof elicitation !== "object") return { form: false, url: false };
  return {
    form: Boolean(elicitation.form != null && typeof elicitation.form === "object"),
    url: Boolean(elicitation.url != null && typeof elicitation.url === "object")
  };
}

/** v1 `initialize`: also returns the client's advertised `fs`, `elicitation`, and `terminal` capabilities. */
export function handleInitializeV1(
  params: V1InitializeRequest,
  agentVersion: string
): {
  response: V1InitializeResponse;
  clientFs: ClientFsCapability;
  clientElicitation: ClientElicitationCapability;
  clientTerminal: ClientTerminalCapability;
} {
  return {
    clientFs: {
      readTextFile: params.clientCapabilities?.fs?.readTextFile ?? false,
      writeTextFile: params.clientCapabilities?.fs?.writeTextFile ?? false
    },
    clientElicitation: parseClientElicitation(params.clientCapabilities),
    clientTerminal: parseClientTerminal(params.clientCapabilities),
    response: {
      protocolVersion:
        params.protocolVersion === v1.PROTOCOL_VERSION ? params.protocolVersion : v1.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true
        },
        mcpCapabilities: {
          http: false,
          sse: false,
          acp: false
        },
        sessionCapabilities: {
          list: {},
          additionalDirectories: {},
          resume: {},
          close: {}
        },
        auth: {
          logout: {}
        },
        elicitation: {},
        terminal: {}
      } as unknown as v1.AgentCapabilities,
      authMethods: v1AuthMethods(),
      agentInfo: { ...AGENT_INFO, version: agentVersion }
    }
  };
}

export function handleInitializeV2(
  params: V2InitializeRequest,
  agentVersion: string
): {
  response: V2InitializeResponse;
  clientElicitation: ClientElicitationCapability;
  clientTerminal: ClientTerminalCapability;
} {
  return {
    clientElicitation: parseClientElicitation(params),
    clientTerminal: parseClientTerminal(params),
    response: {
      protocolVersion:
        params.protocolVersion === v2.PROTOCOL_VERSION ? params.protocolVersion : v2.PROTOCOL_VERSION,
      info: { ...AGENT_INFO, version: agentVersion },
      // Advertising `session` commits to the v2 baseline methods (new/list/resume/close/prompt/cancel/update).
      capabilities: {
        session: {
          prompt: {
            image: {},
            embeddedContext: {}
          },
          additionalDirectories: {}
        },
        auth: {},
        elicitation: {},
        terminal: {}
      } as unknown as v2.AgentCapabilities,
      // Non-empty authMethods commits the agent to auth/login + auth/logout.
      authMethods: v2AuthMethods()
    }
  };
}

