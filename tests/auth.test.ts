import { describe, expect, it } from "vitest";
import {
  AUTH_METHOD_AGENT_STATUS,
  AUTH_METHOD_TERMINAL_LOGIN,
  formatAuthProbeError,
  isKnownAuthMethodId,
  looksUnauthenticated,
  v1AuthMethods,
  v2AuthMethods
} from "../src/agy/auth.js";
import { AgyCliError } from "../src/agy/cli.js";

describe("auth methods", () => {
  it("advertises terminal login and agent status methods", () => {
    const v1 = v1AuthMethods();
    expect(v1).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "terminal",
          id: AUTH_METHOD_TERMINAL_LOGIN,
          args: ["--login"]
        }),
        expect.objectContaining({ id: AUTH_METHOD_AGENT_STATUS })
      ])
    );

    const v2 = v2AuthMethods();
    expect(v2).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "terminal",
          methodId: AUTH_METHOD_TERMINAL_LOGIN,
          args: ["--login"]
        }),
        expect.objectContaining({
          type: "agent",
          methodId: AUTH_METHOD_AGENT_STATUS
        })
      ])
    );
  });

  it("recognizes known method ids", () => {
    expect(isKnownAuthMethodId(AUTH_METHOD_TERMINAL_LOGIN)).toBe(true);
    expect(isKnownAuthMethodId(AUTH_METHOD_AGENT_STATUS)).toBe(true);
    expect(isKnownAuthMethodId("other")).toBe(false);
  });
});

describe("auth probe helpers", () => {
  it("detects not-logged-in errors", () => {
    const err = new AgyCliError(
      "agy models exited with status 1: error getting token source: You are not logged into Antigravity.",
      ["agy", "models"],
      1,
      "You are not logged into Antigravity."
    );
    expect(formatAuthProbeError(err)).toBe("You are not logged into Antigravity.");
    expect(looksUnauthenticated(formatAuthProbeError(err))).toBe(true);
  });
});
