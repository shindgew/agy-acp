import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contentBlocksToPrompt } from "../src/content/index.js";

const PNG_PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("contentBlocksToPrompt", () => {
  it("writes image blocks to the session workspace and references them for agy", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agy-acp-prompt-"));
    try {
      const prompt = await contentBlocksToPrompt([
        { type: "text", text: "describe this" },
        { type: "image", mimeType: "image/png", data: PNG_PIXEL }
      ], cwd);

      expect(prompt).toMatch(/^describe this\n@/);
      const imagePath = prompt.split("\n")[1].slice(1);
      expect(imagePath).toContain(`${path.join(cwd, ".agy-acp", "attachments")}`);
      expect(await readFile(imagePath)).toEqual(Buffer.from(PNG_PIXEL, "base64"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("references file image resource links directly", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agy-acp-prompt-"));
    try {
      const prompt = await contentBlocksToPrompt([
        {
          type: "resource_link",
          uri: "file:///tmp/example.png",
          name: "example.png",
          mimeType: "image/png"
        }
      ], cwd);

      expect(prompt).toBe(`@${path.resolve("/tmp/example.png")}`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});