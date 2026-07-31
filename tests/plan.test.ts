import { describe, expect, it } from "vitest";
import { isPlanFile, parsePlanEntries, planIdForPath, planRemovedFromPath, planUpdateFromMarkdown } from "../src/acp/agent-plan/index.js";

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

  it("rejects non-plan brain markdown artifacts", () => {
    const base = "/Users/me/.gemini/antigravity-cli/brain/abc";
    expect(isPlanFile(`${base}/code_review_v0.3.3.md`)).toBe(false);
    expect(isPlanFile(`${base}/walkthrough.md`)).toBe(false);
    expect(isPlanFile(`${base}/task.md`)).toBe(false);
    expect(isPlanFile(`${base}/content.md`)).toBe(false);
    expect(isPlanFile(`${base}/comparison_analysis.md`)).toBe(false);
  });
});

describe("parsePlanEntries", () => {
  it("parses numbered and bulleted items with stable ids", () => {
    const entries = parsePlanEntries("# Plan\n\n1. First\n2. Second\n- Third\n");
    expect(entries.map((e) => e.content)).toEqual(["First", "Second", "Third"]);
    expect(entries.map((e) => (e as Record<string, unknown>).id)).toEqual([
      "entry_1",
      "entry_2",
      "entry_3"
    ]);
  });

  it("maps checkbox markers to status with ids", () => {
    expect(
      parsePlanEntries("- [ ] open\n- [x] done\n- [~] mid\n- [X] DONE2\n")
    ).toEqual([
      { id: "entry_1", content: "open", priority: "high", status: "pending" },
      { id: "entry_2", content: "done", priority: "high", status: "completed" },
      { id: "entry_3", content: "mid", priority: "high", status: "in_progress" },
      { id: "entry_4", content: "DONE2", priority: "medium", status: "completed" }
    ]);
  });

  it("falls back to the first heading when there is no list", () => {
    expect(parsePlanEntries("# Ship the feature\n\nSome prose only.\n")).toEqual([
      { id: "entry_1", content: "Ship the feature", priority: "medium", status: "pending" }
    ]);
  });
});

describe("planUpdateFromMarkdown & planRemovedFromPath", () => {
  it("builds a classic plan update with stable meta and entry ids", () => {
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

  it("builds a plan_removed update for empty/deleted plans", () => {
    const path = "/Users/me/.gemini/antigravity-cli/brain/c/plan.md";
    const update = planRemovedFromPath(path) as {
      sessionUpdate: string;
      planId: string;
      _meta?: Record<string, unknown>;
    };
    expect(update.sessionUpdate).toBe("plan_removed");
    expect(update.planId).toBe(planIdForPath(path));
    expect(update._meta?.["agy-acp/planId"]).toBe(planIdForPath(path));
  });
});
