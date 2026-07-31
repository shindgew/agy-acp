// ACP Agent Plan: map agy brain-plan markdown artifacts onto plan session updates.
// Docs: https://agentclientprotocol.com/protocol/v1/agent-plan
//
// agy does not expose a structured plan control plane — only markdown files
// under ~/.gemini/antigravity-cli/brain/**. We surface those as:
//   - v1 classic `sessionUpdate: "plan"` with checklist-style entries
//   - v2 `plan_update` with type "items" (mapped at the protocol boundary)
//
// Entry status is inferred only from checkbox markers in the markdown; there is
// no live task-progress channel from agy, so in-progress/completed only update
// when the plan file itself is rewritten with new markers.

import type { PlanEntry as ACPPlanEntry, PlanEntryPriority, PlanEntryStatus, SessionUpdate } from "@agentclientprotocol/sdk";

export type PlanEntry = ACPPlanEntry & { id?: string };

/** Stable plan id derived from the absolute brain file path. */
export function planIdForPath(targetFile: string): string {
  return `file:${targetFile}`;
}

/**
 * Plan artifact filenames agy writes under `brain/**`. Only these are the
 * checklist-style plan; the brain directory also holds many prose artifacts
 * (`task.md`, `walkthrough.md`, `content.md`, `code_review_*.md`,
 * `*_analysis.md`, ...) that must NOT be shredded into bogus plan entries.
 */
const PLAN_FILENAMES = new Set(["implementation_plan.md", "plan.md"]);

/** True when a write target is an agy brain *plan* artifact (not any brain md). */
export function isPlanFile(targetFile: string): boolean {
  if (
    !targetFile.includes(".gemini") ||
    !targetFile.includes("antigravity-cli") ||
    !targetFile.includes("brain")
  ) {
    return false;
  }
  const base = (targetFile.split(/[\\/]/).pop() ?? "").toLowerCase();
  return PLAN_FILENAMES.has(base);
}

/**
 * Parse markdown list items into ACP plan entries.
 *
 * Recognizes:
 *   - `- [ ] task` / `* [x] task` / `1. [~] task`  (checkbox → status)
 *   - `- task` / `* task` / `1. task`               (plain list → pending)
 *
 * When no list items exist, falls back to a single entry from the first
 * meaningful line (heading stripped).
 */
export function parsePlanEntries(markdown: string): PlanEntry[] {
  const entries: PlanEntry[] = [];

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;

    const checkbox = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX~-])\]\s+(.+)$/.exec(line);
    if (checkbox) {
      const content = checkbox[2].trim();
      if (!content) continue;
      entries.push({
        id: entryIdFromContent(content),
        content,
        priority: defaultPriority(entries.length),
        status: checkboxStatus(checkbox[1])
      });
      continue;
    }

    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet) {
      const content = bullet[1].trim();
      // Skip nested bullets that are only emphasis or empty after strip.
      if (!content || content === "-" || content === "*") continue;
      // Ignore list markers that are really horizontal rules / separators.
      if (/^[-*_]{3,}$/.test(content)) continue;
      entries.push({
        id: entryIdFromContent(content),
        content,
        priority: defaultPriority(entries.length),
        status: "pending"
      });
    }
  }

  if (entries.length > 0) return entries;

  const fallback = firstMeaningfulLine(markdown);
  return [
    {
      id: entryIdFromContent(fallback),
      content: fallback,
      priority: "medium",
      status: "pending"
    }
  ];
}

/** Build a classic ACP v1 `plan` session update from plan markdown. */
export function planUpdateFromMarkdown(targetFile: string, markdown: string): SessionUpdate {
  const entries = parsePlanEntries(markdown);
  // Stash path for v2 planId mapping / progressive snapshot keys without
  // inventing a non-schema field on the wire — clients ignore unknown keys? 
  // Actually ACP forbids assumptions on unknown keys but _meta is reserved.
  // Use _meta for agent-side mapping only; strip at boundary if needed.
  return {
    sessionUpdate: "plan",
    entries,
    _meta: {
      "agy-acp/planId": planIdForPath(targetFile),
      "agy-acp/planPath": targetFile,
      "agy-acp/planMarkdown": markdown
    }
  } as SessionUpdate;
}

/** Build an ACP `plan_removed` session update when plan artifact is cleared/deleted. */
export function planRemovedFromPath(targetFile: string): SessionUpdate {
  return {
    sessionUpdate: "plan_removed",
    planId: planIdForPath(targetFile),
    _meta: {
      "agy-acp/planId": planIdForPath(targetFile),
      "agy-acp/planPath": targetFile
    }
  } as SessionUpdate;
}

function checkboxStatus(mark: string): PlanEntryStatus {
  const m = mark.toLowerCase();
  if (m === "x") return "completed";
  if (m === "~" || m === "-") return "in_progress";
  return "pending";
}

function defaultPriority(index: number): PlanEntryPriority {
  // First few items are typically the critical path; rest medium.
  return index < 3 ? "high" : "medium";
}

function firstMeaningfulLine(markdown: string): string {
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Strip ATX headings.
    const withoutHeading = line.replace(/^#{1,6}\s+/, "").trim();
    if (withoutHeading) return withoutHeading.slice(0, 500);
  }
  return "Plan";
}

/**
 * Derive a stable entry ID from the entry's text content.
 * Uses a simple djb2-style hash so that entries keep their identity
 * across insertions, removals, and reordering in the plan markdown.
 */
function entryIdFromContent(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  // Convert to unsigned hex for a short, URL-safe id.
  return `entry_${(hash >>> 0).toString(16)}`;
}
