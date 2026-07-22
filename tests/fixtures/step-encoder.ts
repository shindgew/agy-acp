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

export function encodeStepPayload(opts: {
  toolRun?: Uint8Array;
  agentText?: string;
  titleUpdate?: string;
  userPrompt?: string;
}): Uint8Array {
  const w = new BinaryWriter();
  if (opts.toolRun) submessage(w, 5, opts.toolRun);
  if (opts.agentText !== undefined) submessage(w, 20, encodeAgentText(opts.agentText));
  if (opts.titleUpdate !== undefined) submessage(w, 30, encodeTitleUpdate(opts.titleUpdate));
  if (opts.userPrompt !== undefined) submessage(w, 19, encodeUserPrompt(opts.userPrompt));
  return w.finish();
}
