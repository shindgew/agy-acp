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

export interface ClientFsCapability {
  readTextFile: boolean;
  writeTextFile: boolean;
}

/** v1 `initialize`: also returns the client's advertised `fs` capability for the caller to store. */
export function handleInitializeV1(
  params: V1InitializeRequest,
  agentVersion: string
): { response: V1InitializeResponse; clientFs: ClientFsCapability } {
  return {
    clientFs: {
      readTextFile: params.clientCapabilities?.fs?.readTextFile ?? false,
      writeTextFile: params.clientCapabilities?.fs?.writeTextFile ?? false
    },
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
        }
      },
      authMethods: v1AuthMethods(),
      agentInfo: { ...AGENT_INFO, version: agentVersion }
    }
  };
}

export function handleInitializeV2(
  params: V2InitializeRequest,
  agentVersion: string
): V2InitializeResponse {
  return {
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
      auth: {}
    },
    // Non-empty authMethods commits the agent to auth/login + auth/logout.
    authMethods: v2AuthMethods()
  };
}
