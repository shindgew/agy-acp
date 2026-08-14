import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  contentBlocksToPrompt,
  contentBlocksToText,
  splitTextAndImages,
  tryReadImageContentBlock
} from "../src/acp/content/index.js";

const PNG_PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Adapter must never invent conversational framing around client content. */
const INJECTED_PROSE = [
  /Referenced resource:/i,
  /Resource\s+\S+:/,
  /blob omitted/i,
  /\[image:/i,
  /\bcontinue\b/i,
  /\/fast\b/i
];

function assertNoInjectedProse(prompt: string): void {
  for (const pattern of INJECTED_PROSE) {
    expect(prompt, `must not contain injected prose matching ${pattern}`).not.toMatch(pattern);
  }
}

describe("contentBlocksToPrompt", () => {
  it("passes text blocks through unmodified", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agy-acp-prompt-"));
    try {
      const prompt = await contentBlocksToPrompt([{ type: "text", text: "hello user" }], cwd);
      expect(prompt).toBe("hello user");
      assertNoInjectedProse(prompt);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

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
      assertNoInjectedProse(prompt);
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
      assertNoInjectedProse(prompt);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("forwards non-image resource_link URI without adapter framing", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agy-acp-prompt-"));
    try {
      const prompt = await contentBlocksToPrompt([
        { type: "text", text: "see also" },
        {
          type: "resource_link",
          uri: "file:///repo/src/main.ts",
          name: "main.ts",
          mimeType: "text/typescript"
        }
      ], cwd);

      expect(prompt).toBe("see also\nfile:///repo/src/main.ts");
      assertNoInjectedProse(prompt);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("forwards embedded resource text body without URI labels", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agy-acp-prompt-"));
    try {
      const prompt = await contentBlocksToPrompt([
        { type: "text", text: "review" },
        {
          type: "resource",
          resource: { uri: "file:///repo/notes.md", text: "line one\nline two", mimeType: "text/markdown" }
        }
      ], cwd);

      expect(prompt).toBe("review\nline one\nline two");
      assertNoInjectedProse(prompt);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("omits non-image blobs instead of inventing omission copy", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agy-acp-prompt-"));
    try {
      const prompt = await contentBlocksToPrompt([
        { type: "text", text: "attach" },
        {
          type: "resource",
          resource: {
            uri: "file:///repo/data.bin",
            blob: Buffer.from("binary").toString("base64"),
            mimeType: "application/octet-stream"
          }
        }
      ], cwd);

      expect(prompt).toBe("attach");
      assertNoInjectedProse(prompt);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("contentBlocksToText", () => {
  it("joins client text without invented labels", () => {
    expect(contentBlocksToText([
      { type: "text", text: "first" },
      { type: "text", text: "second" }
    ])).toBe("first\nsecond");
  });

  it("uses client URI and resource body only", () => {
    const text = contentBlocksToText([
      {
        type: "resource_link",
        uri: "file:///x.ts",
        name: "x.ts"
      },
      {
        type: "resource",
        resource: { uri: "file:///y.ts", text: "export {}", mimeType: "text/typescript" }
      },
      { type: "image", mimeType: "image/png", data: PNG_PIXEL }
    ]);
    expect(text).toBe("file:///x.ts\nexport {}");
    assertNoInjectedProse(text);
  });
});

describe("outbound image ContentBlocks", () => {
  it("reads local image file and returns base64 image block", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "agy-acp-img-"));
    try {
      const imgPath = path.join(tmpDir, "test.png");
      await writeFile(imgPath, Buffer.from(PNG_PIXEL, "base64"));

      const block = tryReadImageContentBlock(imgPath);
      expect(block).toEqual({
        type: "image",
        data: PNG_PIXEL,
        mimeType: "image/png"
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null for non-existent image or non-image files", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "agy-acp-img-"));
    try {
      expect(tryReadImageContentBlock(path.join(tmpDir, "missing.png"))).toBeNull();
      const txtPath = path.join(tmpDir, "not-image.txt");
      await writeFile(txtPath, "hello");
      expect(tryReadImageContentBlock(txtPath)).toBeNull();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("splits text containing markdown images into text and image ContentBlocks", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "agy-acp-img-"));
    try {
      const imgPath = path.join(tmpDir, "chart.png");
      await writeFile(imgPath, Buffer.from(PNG_PIXEL, "base64"));

      const text = `Here is the chart:\n![chart](${imgPath})\nLooks good!`;
      const blocks = splitTextAndImages(text, tmpDir);

      expect(blocks).toHaveLength(3);
      expect(blocks[0]).toEqual({ type: "text", text: "Here is the chart:\n" });
      expect(blocks[1]).toEqual({ type: "image", data: PNG_PIXEL, mimeType: "image/png" });
      expect(blocks[2]).toEqual({ type: "text", text: "\nLooks good!" });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves plain text when markdown images do not exist on disk", () => {
    const text = "Here is an external image:\n![remote](https://example.com/img.png)\nDone.";
    const blocks = splitTextAndImages(text);
    expect(blocks).toEqual([{ type: "text", text }]);
  });
});
