import { describe, expect, it } from "vitest";
import { decodeGenMetadata } from "../src/agy/db/gen-metadata.js";
import { encodeGenMetadata } from "./fixtures/step-encoder.js";

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
      totalTokens: 1650,
      contextWindowSize: 1048576,
      maxOutputTokens: 65536,
      modelSlug: "gemini-3.7-flash",
      modelDisplayName: "Gemini 3.7 Flash (High)"
    });
  });

  it("handles null/empty bytes gracefully", () => {
    expect(decodeGenMetadata(1, new Uint8Array())).toBeNull();
  });
});
