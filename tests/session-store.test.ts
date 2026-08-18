import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore, type StoredSession } from "../src/acp/session/store.js";

function sampleSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    cwd: "/workspace",
    additionalDirectories: [],
    conversationId: "conv-1",
    lastStepIdx: 0,
    model: "gemini-2.5-flash",
    reasoningEffort: "",
    v2UserMessageIdsByStep: {},
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

describe("SessionStore.persist", () => {
  it("rejects when the state directory cannot be created", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-store-"));
    const blocker = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(blocker, "x");
    const store = new SessionStore(blocker);
    try {
      await expect(store.persist("child-1", sampleSession())).rejects.toThrow();
      expect(await store.restore("child-1")).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps the write chain healthy after a rejected persist", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-store-chain-"));
    const store = new SessionStore(stateDir);
    try {
      await store.persist("ok-1", sampleSession({ conversationId: "c1" }));
      fs.chmodSync(stateDir, 0o555);
      await expect(store.persist("fail-1", sampleSession({ conversationId: "c-fail" }))).rejects.toThrow();
      fs.chmodSync(stateDir, 0o755);
      await store.persist("ok-2", sampleSession({ conversationId: "c2" }));
      expect(await store.restore("ok-1")).toMatchObject({ conversationId: "c1" });
      expect(await store.restore("fail-1")).toBeNull();
      expect(await store.restore("ok-2")).toMatchObject({ conversationId: "c2" });
    } finally {
      try { fs.chmodSync(stateDir, 0o755); } catch {}
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
