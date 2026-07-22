// Minimal protobuf encoder for building `steps` table fixtures in tests. Only
// covers the fields our decoder (src/db/step-payload.ts) actually reads;
// field numbers must match that module's decode side exactly.

import { BinaryWriter } from "@bufbuild/protobuf/wire";

function submessage(writer: BinaryWriter, fieldNo: number, bytes: Uint8Array): void {
  writer.tag(fieldNo, 2).bytes(bytes);
}

export function encodeToolCall(call: {
  callId?: string;
  namePrimary?: string;
  rawInputJson?: string;
  nameSecondary?: string;
}): Uint8Array {
  const w = new BinaryWriter();
  if (call.callId) w.tag(1, 2).string(call.callId);
  if (call.namePrimary) w.tag(2, 2).string(call.namePrimary);
  if (call.rawInputJson) w.tag(3, 2).string(call.rawInputJson);
  if (call.nameSecondary) w.tag(9, 2).string(call.nameSecondary);
  return w.finish();
}

export function encodeToolRun(run: { call?: Uint8Array; titlePrimary?: string; titleSecondary?: string }): Uint8Array {
  const w = new BinaryWriter();
  if (run.call) submessage(w, 4, run.call);
  if (run.titlePrimary) w.tag(30, 2).string(run.titlePrimary);
  if (run.titleSecondary) w.tag(31, 2).string(run.titleSecondary);
  return w.finish();
}

export function encodeAgentText(text: string): Uint8Array {
  const w = new BinaryWriter();
  w.tag(1, 2).string(text);
  return w.finish();
}

export function encodeTitleUpdate(title: string): Uint8Array {
  const w = new BinaryWriter();
  w.tag(4, 2).string(title);
  return w.finish();
}

export function encodeUserPrompt(text: string): Uint8Array {
  const w = new BinaryWriter();
  w.tag(2, 2).string(text);
  return w.finish();
}

export function encodeCommandResult(result: {
  cwd?: string;
  exitCode?: number;
  output?: string;
  command?: string;
}): Uint8Array {
  const w = new BinaryWriter();
  if (result.cwd) w.tag(2, 2).string(result.cwd);
  if (result.exitCode !== undefined) w.tag(6, 0).int64(result.exitCode);
  if (result.output) w.tag(21, 2).string(result.output);
  if (result.command) {
    w.tag(23, 2).string(result.command);
    w.tag(25, 2).string(result.command);
  }
  return w.finish();
}

export function encodeWebSearchResult(result: { query?: string; refinedQueryOrUrl?: string }): Uint8Array {
  const w = new BinaryWriter();
  if (result.query) w.tag(1, 2).string(result.query);
  if (result.refinedQueryOrUrl) w.tag(5, 2).string(result.refinedQueryOrUrl);
  return w.finish();
}

export function encodeUrlContentResult(result: {
  url?: string;
  title?: string;
  description?: string;
  body?: string;
  contentPath?: string;
}): Uint8Array {
  const w = new BinaryWriter();
  if (result.url) w.tag(1, 2).string(result.url);

  // document submessage (field 2): title=4, body nested at 6.3.2, description=7
  if (result.title || result.description || result.body) {
    const doc = new BinaryWriter();
    if (result.title) doc.tag(4, 2).string(result.title);
    if (result.body) {
      const bodyInner = new BinaryWriter();
      bodyInner.tag(2, 2).string(result.body);
      const bodyWrap = new BinaryWriter();
      submessage(bodyWrap, 3, bodyInner.finish());
      submessage(doc, 6, bodyWrap.finish());
    }
    if (result.description) doc.tag(7, 2).string(result.description);
    submessage(w, 2, doc.finish());
  }

  if (result.contentPath) w.tag(6, 2).string(result.contentPath);
  return w.finish();
}

export function encodeViewFileResult(result: {
  fileUri?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
}): Uint8Array {
  const w = new BinaryWriter();
  if (result.fileUri) w.tag(1, 2).string(result.fileUri);
  if (result.startLine !== undefined) w.tag(2, 0).int64(result.startLine);
  if (result.endLine !== undefined) w.tag(3, 0).int64(result.endLine);
  if (result.content !== undefined) w.tag(4, 2).string(result.content);
  return w.finish();
}

/** permissions column: { 2: { 1: { 1: kind, 2: value }, 2: decision } }. */
export function encodePermissions(info: { kind?: string; value?: string; decision?: number }): Uint8Array {
  const target = new BinaryWriter();
  if (info.kind) target.tag(1, 2).string(info.kind);
  if (info.value) target.tag(2, 2).string(info.value);

  const entry = new BinaryWriter();
  submessage(entry, 1, target.finish());
  if (info.decision !== undefined) entry.tag(2, 0).int64(info.decision);

  const w = new BinaryWriter();
  submessage(w, 2, entry.finish());
  return w.finish();
}

export function encodeStepPayload(opts: {
  toolRun?: Uint8Array;
  agentText?: string;
  titleUpdate?: string;
  userPrompt?: string;
  commandResult?: Uint8Array;
  viewFile?: Uint8Array;
  webSearch?: Uint8Array;
  urlContent?: Uint8Array;
}): Uint8Array {
  const w = new BinaryWriter();
  if (opts.toolRun) submessage(w, 5, opts.toolRun);
  if (opts.viewFile) submessage(w, 14, opts.viewFile);
  if (opts.userPrompt !== undefined) submessage(w, 19, encodeUserPrompt(opts.userPrompt));
  if (opts.agentText !== undefined) submessage(w, 20, encodeAgentText(opts.agentText));
  if (opts.commandResult) submessage(w, 28, opts.commandResult);
  if (opts.titleUpdate !== undefined) submessage(w, 30, encodeTitleUpdate(opts.titleUpdate));
  if (opts.urlContent) submessage(w, 40, opts.urlContent);
  if (opts.webSearch) submessage(w, 42, opts.webSearch);
  return w.finish();
}
