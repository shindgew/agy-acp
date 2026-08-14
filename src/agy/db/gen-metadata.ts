// Decoder for the protobuf blob in the `gen_metadata` column of agy's
// per-conversation SQLite databases (`~/.gemini/antigravity-cli/conversations/<id>.db`).
//
// Field numbers and structures reverse-engineered from real agy conversation databases:
//   - Root field 1 (GenerationMetadata submessage):
//     - Field 4 (ModelUsageStats):
//       - 2: prompt_token_count (uncached input tokens)
//       - 3: candidates_token_count (total output tokens)
//       - 5: cached_content_token_count (cached input tokens)
//       - 9: thoughts_token_count (reasoning/thought tokens)
//       - 10: content_tokens (non-thought output tokens)
//     - Field 9: submessage containing context window limit at 10.4
//     - Field 15: submessage containing max output tokens at 15.2
//     - Field 19: model slug (e.g. "gemini-3.7-flash")
//     - Field 21: model display name (e.g. "Gemini 3.7 Flash (High)")

import { readInt, readMessage, readSubmessage } from "./protowire.js";

export interface ModelUsageStats {
  promptTokens: number;
  candidatesTokens: number;
  cachedTokens: number;
  thoughtTokens: number;
  contentTokens: number;
}

export interface GenMetadataUsage {
  idx: number;
  promptTokens: number;
  candidatesTokens: number;
  cachedTokens: number;
  thoughtTokens: number;
  contentTokens: number;
  totalInputTokens: number;
  totalTokens: number;
  contextWindowSize?: number;
  maxOutputTokens?: number;
  modelSlug?: string;
  modelDisplayName?: string;
}

function decodeModelUsageStats(bytes: Uint8Array): ModelUsageStats {
  return readMessage<ModelUsageStats>(
    bytes,
    {
      promptTokens: 0,
      candidatesTokens: 0,
      cachedTokens: 0,
      thoughtTokens: 0,
      contentTokens: 0
    },
    {
      2: (m, r) => (m.promptTokens = readInt(r)),
      3: (m, r) => (m.candidatesTokens = readInt(r)),
      5: (m, r) => (m.cachedTokens = readInt(r)),
      9: (m, r) => (m.thoughtTokens = readInt(r)),
      10: (m, r) => (m.contentTokens = readInt(r))
    }
  );
}

function decodeContextLimitSubmessage(bytes: Uint8Array): { contextWindowSize?: number } {
  return readMessage<{ contextWindowSize?: number }>(
    bytes,
    {},
    {
      4: (m, r) => (m.contextWindowSize = readInt(r))
    }
  );
}

function decodeField9Submessage(bytes: Uint8Array): { contextWindowSize?: number } {
  return readMessage<{ contextWindowSize?: number }>(
    bytes,
    {},
    {
      10: (m, r) => {
        const sub = readSubmessage(r, decodeContextLimitSubmessage);
        if (sub.contextWindowSize) m.contextWindowSize = sub.contextWindowSize;
      }
    }
  );
}

function decodeField15Submessage(bytes: Uint8Array): { maxOutputTokens?: number } {
  return readMessage<{ maxOutputTokens?: number }>(
    bytes,
    {},
    {
      2: (m, r) => (m.maxOutputTokens = readInt(r))
    }
  );
}

interface GenerationMetadataBody {
  stats: ModelUsageStats | null;
  contextWindowSize?: number;
  maxOutputTokens?: number;
  modelSlug?: string;
  modelDisplayName?: string;
}

function decodeGenerationMetadataBody(bytes: Uint8Array): GenerationMetadataBody {
  return readMessage<GenerationMetadataBody>(
    bytes,
    { stats: null },
    {
      4: (m, r) => (m.stats = readSubmessage(r, decodeModelUsageStats)),
      9: (m, r) => {
        const f9 = readSubmessage(r, decodeField9Submessage);
        if (f9.contextWindowSize) m.contextWindowSize = f9.contextWindowSize;
      },
      15: (m, r) => {
        const f15 = readSubmessage(r, decodeField15Submessage);
        if (f15.maxOutputTokens) m.maxOutputTokens = f15.maxOutputTokens;
      },
      17: (m, r) => {
        // Fallback: if field 4 was not populated, read stats from field 17.2
        if (!m.stats) {
          readMessage(r.bytes(), {}, {
            2: (_m2, r2) => (m.stats = readSubmessage(r2, decodeModelUsageStats))
          });
        }
      },
      19: (m, r) => (m.modelSlug = r.string()),
      21: (m, r) => (m.modelDisplayName = r.string())
    }
  );
}

export function decodeGenMetadata(idx: number, bytes: Uint8Array): GenMetadataUsage | null {
  if (!bytes || bytes.length === 0) return null;

  const wrapper = readMessage<{ body: GenerationMetadataBody | null }>(
    bytes,
    { body: null },
    {
      1: (m, r) => (m.body = readSubmessage(r, decodeGenerationMetadataBody))
    }
  );

  const body = wrapper.body;
  if (!body || !body.stats) return null;

  const stats = body.stats;
  // prompt_token_count in provider usage represents total prompt tokens,
  // with cached_content_token_count indicating the cached subset.
  const totalInputTokens = stats.promptTokens;
  const totalTokens = totalInputTokens + stats.candidatesTokens;

  return {
    idx,
    promptTokens: stats.promptTokens,
    candidatesTokens: stats.candidatesTokens,
    cachedTokens: stats.cachedTokens,
    thoughtTokens: stats.thoughtTokens,
    contentTokens: stats.contentTokens,
    totalInputTokens,
    totalTokens,
    contextWindowSize: body.contextWindowSize,
    maxOutputTokens: body.maxOutputTokens,
    modelSlug: body.modelSlug,
    modelDisplayName: body.modelDisplayName
  };
}
