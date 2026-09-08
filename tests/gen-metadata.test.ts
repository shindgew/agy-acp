import { describe, expect, it } from "vitest";
import { BinaryWriter } from "@bufbuild/protobuf/wire";
import { decodeGenMetadata } from "../src/agy/db/gen-metadata.js";
import { encodeGenMetadata } from "./fixtures/step-encoder.js";

function submessage(writer: BinaryWriter, fieldNo: number, bytes: Uint8Array): void {
  writer.tag(fieldNo, 2).bytes(bytes);
}

describe("decodeGenMetadata", () => {
  it("decodes token metrics, context limits, and model info from protobuf bytes", () => {
    const bytes = encodeGenMetadata({
      promptTokens: 1200,
      candidatesTokens: 450,
      cachedTokens: 800,
      thoughtTokens: 150,
      contentTokens: 300,
      contextWindowSize: 1048576,
      maxOutputTokens: 65536,
      modelSlug: "gemini-3.7-flash",
      modelDisplayName: "Gemini 3.7 Flash (High)"
    });

    const decoded = decodeGenMetadata(42, bytes);
    expect(decoded).toEqual({
      idx: 42,
      promptTokens: 1200,
      candidatesTokens: 450,
      cachedTokens: 800,
      thoughtTokens: 150,
      contentTokens: 300,
      totalInputTokens: 1200,
      totalTokens: 1800,
      contextWindowSize: 1048576,
      maxOutputTokens: 65536,
      modelSlug: "gemini-3.7-flash",
      modelDisplayName: "Gemini 3.7 Flash (High)"
    });
  });

  it("handles null/empty bytes gracefully", () => {
    expect(decodeGenMetadata(1, new Uint8Array())).toBeNull();
  });

  it("ignores the modern field-17 sidecar after decoding field-4 usage", () => {
    const usage = new BinaryWriter();
    usage.tag(2, 0).int64(21706);
    usage.tag(3, 0).int64(1036);
    usage.tag(9, 0).int64(936);
    usage.tag(10, 0).int64(100);
    const usageBytes = usage.finish();

    const sidecar = new BinaryWriter();
    // agy 1.1.27 writes this alongside the canonical field-4 usage record.
    submessage(sidecar, 2, usageBytes);

    const body = new BinaryWriter();
    submessage(body, 4, usageBytes);
    submessage(body, 17, sidecar.finish());
    body.tag(19, 2).string("gemini-3.8-flash");

    const root = new BinaryWriter();
    submessage(root, 1, body.finish());

    expect(decodeGenMetadata(7, root.finish())).toMatchObject({
      idx: 7,
      promptTokens: 21706,
      candidatesTokens: 1036,
      thoughtTokens: 936,
      contentTokens: 100,
      modelSlug: "gemini-3.8-flash"
    });
  });
});
