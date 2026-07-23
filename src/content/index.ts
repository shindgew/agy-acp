// ACP Content: map prompt ContentBlock[] (text / image / resource) onto agy input.
// Docs: https://agentclientprotocol.com/protocol/v1/content

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentBlock } from "@agentclientprotocol/sdk";

const ATTACHMENTS_DIR = ".agy-acp/attachments";

export async function promptBlocksToAgyPrompt(blocks: ContentBlock[], cwd: string): Promise<string> {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
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
        parts.push(agyAttachmentReference(filePathFromUri(block.uri)));
      } else {
        parts.push(`Referenced resource: ${block.uri}`);
      }
      continue;
    }

    if (block.type === "resource") {
      parts.push(await resourceBlockToPrompt(block, cwd));
    }
  }
  return parts.join("\n");
}

export function promptBlocksToText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "resource_link") {
      parts.push(`Referenced resource: ${block.uri}`);
    } else if (block.type === "resource") {
      parts.push(resourceBlockToText(block));
    } else if (block.type === "image") {
      parts.push(`[image: ${block.mimeType}]`);
    }
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
  return resourceBlockToText(block);
}

function resourceBlockToText(block: Extract<ContentBlock, { type: "resource" }>): string {
  const resource = block.resource;
  if ("text" in resource) {
    return `Resource ${resource.uri}:\n${resource.text}`;
  }
  return `Resource ${resource.uri}: [${resource.mimeType ?? "application/octet-stream"} blob omitted]`;
}

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

function extensionForMimeType(mimeType: string): string {
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
    default:
      return ".img";
  }
}

function isImageMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("image/");
}

function filePathFromUri(uri: string): string {
  if (uri.startsWith("file://")) {
    return fileURLToPath(uri);
  }
  return uri;
}