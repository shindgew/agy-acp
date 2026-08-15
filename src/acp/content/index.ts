// ACP Content: map prompt ContentBlock[] (text / image / resource) onto agy input.
// Docs: https://agentclientprotocol.com/protocol/v1/content
//
// Zero prompt injection: every substring forwarded to agy must come from the ACP
// client's session/prompt content (or be agy's native attachment transport for
// client-provided image bytes). Never invent conversational labels, instructions,
// follow-ups ("continue"), or framing prose around client data.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentBlock } from "@agentclientprotocol/sdk";

const ATTACHMENTS_DIR = ".agy-acp/attachments";

/**
 * Encode client ContentBlocks into a single agy prompt string.
 *
 * - text → block.text as-is
 * - image / image resource → write bytes, reference with agy `@path` transport
 * - resource_link (non-image) → uri only (client-supplied)
 * - embedded text resource → resource.text only (client-supplied body)
 * - non-image blobs → omitted (no invented "blob omitted" copy)
 *
 * Parts are joined with newlines; empty parts are dropped.
 */
export async function contentBlocksToPrompt(blocks: ContentBlock[], cwd: string): Promise<string> {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text.length > 0) parts.push(block.text);
      continue;
    }

    if (block.type === "image") {
      const filePath = await writeImageAttachment(
        cwd,
        Buffer.from(block.data, "base64"),
        block.mimeType
      );
      parts.push(agyAttachmentReference(filePath));
      continue;
    }

    if (block.type === "resource_link") {
      if (isImageMimeType(block.mimeType) && block.uri) {
        const filePath = filePathFromUri(block.uri);
        if (filePath) {
          parts.push(agyAttachmentReference(filePath));
        } else {
          parts.push(block.uri);
        }
      } else if (block.uri) {
        // Client-supplied URI only — no adapter prose.
        parts.push(block.uri);
      }
      continue;
    }

    if (block.type === "resource") {
      const encoded = await resourceBlockToPrompt(block, cwd);
      if (encoded.length > 0) parts.push(encoded);
    }
  }
  return parts.join("\n");
}

/** Flatten client content to plain text for display/logging — no invented copy. */
export function contentBlocksToText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text.length > 0) parts.push(block.text);
    } else if (block.type === "resource_link") {
      if (block.uri) parts.push(block.uri);
    } else if (block.type === "resource") {
      const text = resourceBlockClientText(block);
      if (text.length > 0) parts.push(text);
    }
    // image blocks have no client text payload for display
  }
  return parts.join("\n");
}

async function resourceBlockToPrompt(
  block: Extract<ContentBlock, { type: "resource" }>,
  cwd: string
): Promise<string> {
  const resource = block.resource;
  if ("blob" in resource && isImageMimeType(resource.mimeType)) {
    const filePath = await writeImageAttachment(
      cwd,
      Buffer.from(resource.blob, "base64"),
      resource.mimeType ?? "application/octet-stream"
    );
    return agyAttachmentReference(filePath);
  }
  return resourceBlockClientText(block);
}

/** Client-authored body only; never wrap with URI labels or omission notices. */
function resourceBlockClientText(block: Extract<ContentBlock, { type: "resource" }>): string {
  const resource = block.resource;
  if ("text" in resource && typeof resource.text === "string") {
    return resource.text;
  }
  return "";
}

/**
 * agy native file-attachment transport for client-provided image bytes.
 * `@` + absolute path is how agy attaches files — not conversational prose.
 */
function agyAttachmentReference(filePath: string): string {
  return `@${path.resolve(filePath)}`;
}

async function writeImageAttachment(
  cwd: string,
  data: Buffer,
  mimeType: string
): Promise<string> {
  const dir = path.join(cwd, ATTACHMENTS_DIR);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${randomUUID()}${extensionForMimeType(mimeType)}`);
  await writeFile(filePath, data);
  return filePath;
}

export function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/bmp":
      return ".bmp";
    case "image/avif":
      return ".avif";
    case "image/svg+xml":
      return ".svg";
    default:
      return ".img";
  }
}

export function mimeTypeForPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".bmp":
      return "image/bmp";
    case ".avif":
      return "image/avif";
    default:
      return null;
  }
}

export function isImageMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("image/");
}

export function filePathFromUri(uri: string): string | null {
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return null;
    }
  }
  return uri;
}

const MAX_IMAGE_READ_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Attempt to read a local image file and return an ACP image ContentBlock.
 * Returns null if the file does not exist, is not an image, or exceeds maxBytes.
 */
export function tryReadImageContentBlock(
  filePath: string,
  maxBytes = MAX_IMAGE_READ_BYTES
): { type: "image"; data: string; mimeType: string } | null {
  try {
    const resolved = filePathFromUri(filePath);
    if (!resolved) return null;
    const mimeType = mimeTypeForPath(resolved);
    if (!mimeType) return null;
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const data = fs.readFileSync(resolved).toString("base64");
    return { type: "image", data, mimeType };
  } catch {
    return null;
  }
}

function getCodeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];

  // Fenced code blocks: ```...``` or ~~~...~~~
  const fencedRegex = /(?:^|\n)(```+|~~~+)[\s\S]*?(?:\n\1[^\n]*|$)/g;
  let m: RegExpExecArray | null;
  while ((m = fencedRegex.exec(text)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
  }

  // Inline code spans: `...` or ``...``
  const inlineRegex = /(`+)(?:[\s\S]*?[^`])\1(?!`)/g;
  while ((m = inlineRegex.exec(text)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
  }

  return spans;
}

export interface SpannedContentBlock {
  block: ContentBlock;
  start: number;
  end: number;
}

/**
 * Splits agent markdown text into spanned alternating text and image ContentBlocks with their
 * character offset ranges [start, end] within the input text.
 * Excludes escaped openers (\!) and markdown code contexts (inline spans, fenced blocks).
 */
export function splitTextAndImagesWithRanges(
  text: string,
  cwd?: string,
  supersededPaths?: Set<string>
): SpannedContentBlock[] {
  if (!text || !text.includes("![")) {
    return [{ block: { type: "text", text }, start: 0, end: text.length }];
  }

  const codeSpans = getCodeSpans(text);
  const imageRegex = /!\[(.*?)\]\((?:<([^>]+)>|([^)\s]+))\)/g;
  const spans: SpannedContentBlock[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = imageRegex.exec(text)) !== null) {
    // Exclude escaped openers: \![caption](...)
    let backslashes = 0;
    for (let i = match.index - 1; i >= 0 && text[i] === "\\"; i--) {
      backslashes++;
    }
    if (backslashes % 2 === 1) continue;

    // Exclude inline code spans and fenced code blocks
    const matchIdx = match.index;
    if (codeSpans.some(([start, end]) => matchIdx >= start && matchIdx < end)) continue;

    const rawPath = (match[2] ?? match[3])!;
    let unescaped = rawPath;
    if (!rawPath.startsWith("file://") && rawPath.includes("%")) {
      try {
        unescaped = decodeURIComponent(rawPath);
      } catch {
        continue;
      }
    }

    const resolvedPath = unescaped.startsWith("file://")
      ? filePathFromUri(unescaped)
      : path.isAbsolute(unescaped)
      ? unescaped
      : cwd
      ? path.resolve(cwd, unescaped)
      : unescaped;

    if (!resolvedPath) continue;
    // Do not reconstruct historical markdown images from disk if a later step modified that path
    if (supersededPaths?.has(resolvedPath)) continue;

    const imgBlock = tryReadImageContentBlock(resolvedPath);
    if (imgBlock) {
      if (match.index > lastIndex) {
        spans.push({
          block: { type: "text", text: text.slice(lastIndex, match.index) },
          start: lastIndex,
          end: match.index
        });
      }
      spans.push({
        block: imgBlock,
        start: match.index,
        end: match.index + match[0].length
      });
      lastIndex = match.index + match[0].length;
    }
  }

  if (lastIndex === 0) {
    return [{ block: { type: "text", text }, start: 0, end: text.length }];
  }

  if (lastIndex < text.length) {
    spans.push({
      block: { type: "text", text: text.slice(lastIndex) },
      start: lastIndex,
      end: text.length
    });
  }

  return spans;
}

/**
 * Splits agent markdown text into alternating text and image ContentBlocks
 * when local markdown image embeds (![caption](/path/to/img)) reference readable images on disk.
 * Excludes escaped openers (\!) and markdown code contexts (inline spans, fenced blocks).
 */
export function splitTextAndImages(text: string, cwd?: string, supersededPaths?: Set<string>): ContentBlock[] {
  return splitTextAndImagesWithRanges(text, cwd, supersededPaths).map((s) => s.block);
}
