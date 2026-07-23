import { describe, expect, it } from "vitest";
import { isPlanFile, parsePlanEntries, planIdForPath, planUpdateFromMarkdown } from "../src/agent-plan/index.js";

describe("isPlanFile", () => {
  it("matches agy brain markdown paths", () => {
    expect(
      isPlanFile(
        "/Users/me/.gemini/antigravity-cli/brain/abc/.system_generated/steps/1/implementation_plan.md"
      )
    ).toBe(true);
  });

  it("rejects ordinary project files", () => {
    expect(isPlanFile("/repo/docs/plan.md")).toBe(false);
    expect(isPlanFile("/Users/me/.gemini/antigravity-cli/brain/x/note.txt")).toBe(false);
  });
});

describe("parsePlanEntries", () => {
  it("parses numbered and bulleted items", () => {
    expect(
      parsePlanEntries("# Plan\n\n1. First\n2. Second\n- Third\n").map((e) => e.content)
    ).toEqual(["First", "Second", "Third"]);
  });

  it("maps checkbox markers to status", () => {
    expect(
      parsePlanEntries("- [ ] open\n- [x] done\n- [~] mid\n- [X] DONE2\n")
    ).toEqual([
      { content: "open", priority: "high", status: "pending" },
      { content: "done", priority: "high", status: "completed" },
      { content: "mid", priority: "high", status: "in_progress" },
      { content: "DONE2", priority: "medium", status: "completed" }
    ]);
  });

  it("falls back to the first heading when there is no list", () => {
    expect(parsePlanEntries("# Ship the feature\n\nSome prose only.\n")).toEqual([
      { content: "Ship the feature", priority: "medium", status: "pending" }
    ]);
  });
});

describe("planUpdateFromMarkdown", () => {
  it("builds a classic plan update with stable meta", () => {
    const path = "/Users/me/.gemini/antigravity-cli/brain/c/plan.md";
    const md = "1. A\n2. B\n";
    const update = planUpdateFromMarkdown(path, md) as {
      sessionUpdate: string;
      entries: unknown[];
      _meta?: Record<string, unknown>;
    };
    expect(update.sessionUpdate).toBe("plan");
    expect(update.entries).toHaveLength(2);
    expect(update._meta?.["agy-acp/planId"]).toBe(planIdForPath(path));
    expect(update._meta?.["agy-acp/planMarkdown"]).toBe(md);
  });
});
