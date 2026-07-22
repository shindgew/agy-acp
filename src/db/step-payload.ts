// Decoder for the protobuf blob in the `step_payload` column of agy's
// per-conversation SQLite databases (`~/.gemini/antigravity-cli/conversations/<id>.db`).
//
// agy does not publish a .proto schema for this format. The field numbers
// below were determined by inspecting real conversation databases (informed by
// the open-source reverse-engineering in shubzkothekar/antigravity-acp). They
// describe an external binary format agy already writes, so treat the field
// numbers/wire types as load-bearing facts, not a design to be reshuffled —
// but the decoding *code* here is our own compact hand-rolled reader rather
// than a generated client, built on the generic `readMessage` walker in
// ./protowire.ts instead of one bespoke switch statement per message.

import { readInt, readMessage, readSubmessage } from "./protowire.js";

export interface ToolCall {
  callId: string;
  namePrimary: string;
  rawInputJson: string;
  nameSecondary: string;
}

export interface ToolRun {
  call: ToolCall | undefined;
  titlePrimary: string;
  titleSecondary: string;
}

/** Fields 1-5 of a grep/web-search hit; likely file path, line, matched text, etc. */
export interface SearchHit {
  field1: string;
  field2: string;
  field3: string;
  field4: string;
  field5: string;
}

export interface WriteFileResult {
  summary: string;
}

export interface GrepSearchResult {
  query: string;
  includeGlob: string;
  textOutput: string;
  hits: SearchHit[];
  shellCommand: string;
  cwdUri: string;
}

export interface ViewFileResult {
  fileUri: string;
  startLine: number;
  endLine: number;
  content: string;
  nextLine: number;
  fileSizeOrTotal: number;
}

export interface DirEntry {
  name: string;
  isDirectory: number;
  fileSize: number;
}

export interface ListDirectoryResult {
  dirUri: string;
  entries: DirEntry[];
}

export interface UserPromptContent {
  text: string;
}

export interface UserPrompt {
  text: string;
  content: UserPromptContent | undefined;
}

export interface AgentText {
  text: string;
}

export interface TitleUpdate {
  title: string;
}

/**
 * Step-payload field 28 — run_command result (decoded from real conversation DBs).
 * Field numbers are load-bearing reverse-engineered facts, not a public schema.
 */
export interface CommandResult {
  cwd: string;
  exitCode: number;
  /** Shell stdout/stderr text when present (may include truncation markers). */
  output: string;
  command: string;
}

/** The blob in the `task_details` column. */
export interface TaskDetails {
  taskId: string;
  logUri: string;
  description: string;
}

/** The blob in the `step_payload` column. Step-type meaning:
 *  5,7,8,9,17,21,33,101,138 = tool run; 15 = agent text; 23 = title update. */
export interface StepPayload {
  validityCheck: number;
  toolRun: ToolRun | undefined;
  writeFile: WriteFileResult | undefined;
  grepSearch: GrepSearchResult | undefined;
  viewFile: ViewFileResult | undefined;
  listDirectory: ListDirectoryResult | undefined;
  userPrompt: UserPrompt | undefined;
  agentText: AgentText | undefined;
  titleUpdate: TitleUpdate | undefined;
  commandResult: CommandResult | undefined;
}

function decodeToolCall(bytes: Uint8Array): ToolCall {
  return readMessage(bytes, { callId: "", namePrimary: "", rawInputJson: "", nameSecondary: "" }, {
    1: (m, r) => (m.callId = r.string()),
    2: (m, r) => (m.namePrimary = r.string()),
    3: (m, r) => (m.rawInputJson = r.string()),
    9: (m, r) => (m.nameSecondary = r.string())
  });
}

function decodeToolRun(bytes: Uint8Array): ToolRun {
  return readMessage<ToolRun>(bytes, { call: undefined, titlePrimary: "", titleSecondary: "" }, {
    4: (m, r) => (m.call = readSubmessage(r, decodeToolCall)),
    30: (m, r) => (m.titlePrimary = r.string()),
    31: (m, r) => (m.titleSecondary = r.string())
  });
}

function decodeSearchHit(bytes: Uint8Array): SearchHit {
  return readMessage(bytes, { field1: "", field2: "", field3: "", field4: "", field5: "" }, {
    1: (m, r) => (m.field1 = r.string()),
    2: (m, r) => (m.field2 = r.string()),
    3: (m, r) => (m.field3 = r.string()),
    4: (m, r) => (m.field4 = r.string()),
    5: (m, r) => (m.field5 = r.string())
  });
}

function decodeWriteFileResult(bytes: Uint8Array): WriteFileResult {
  return readMessage(bytes, { summary: "" }, {
    26: (m, r) => (m.summary = r.string())
  });
}

function decodeGrepSearchResult(bytes: Uint8Array): GrepSearchResult {
  return readMessage<GrepSearchResult>(
    bytes,
    { query: "", includeGlob: "", textOutput: "", hits: [], shellCommand: "", cwdUri: "" },
    {
      1: (m, r) => (m.query = r.string()),
      2: (m, r) => (m.includeGlob = r.string()),
      3: (m, r) => (m.textOutput = r.string()),
      4: (m, r) => m.hits.push(readSubmessage(r, decodeSearchHit)),
      10: (m, r) => (m.shellCommand = r.string()),
      11: (m, r) => (m.cwdUri = r.string())
    }
  );
}

function decodeViewFileResult(bytes: Uint8Array): ViewFileResult {
  return readMessage(
    bytes,
    { fileUri: "", startLine: 0, endLine: 0, content: "", nextLine: 0, fileSizeOrTotal: 0 },
    {
      1: (m, r) => (m.fileUri = r.string()),
      2: (m, r) => (m.startLine = readInt(r)),
      3: (m, r) => (m.endLine = readInt(r)),
      4: (m, r) => (m.content = r.string()),
      11: (m, r) => (m.nextLine = readInt(r)),
      12: (m, r) => (m.fileSizeOrTotal = readInt(r))
    }
  );
}

function decodeDirEntry(bytes: Uint8Array): DirEntry {
  return readMessage(bytes, { name: "", isDirectory: 0, fileSize: 0 }, {
    1: (m, r) => (m.name = r.string()),
    2: (m, r) => (m.isDirectory = readInt(r)),
    4: (m, r) => (m.fileSize = readInt(r))
  });
}

function decodeListDirectoryResult(bytes: Uint8Array): ListDirectoryResult {
  return readMessage<ListDirectoryResult>(bytes, { dirUri: "", entries: [] }, {
    1: (m, r) => (m.dirUri = r.string()),
    3: (m, r) => m.entries.push(readSubmessage(r, decodeDirEntry))
  });
}

function decodeUserPromptContent(bytes: Uint8Array): UserPromptContent {
  return readMessage(bytes, { text: "" }, { 1: (m, r) => (m.text = r.string()) });
}

function decodeUserPrompt(bytes: Uint8Array): UserPrompt {
  return readMessage<UserPrompt>(bytes, { text: "", content: undefined }, {
    2: (m, r) => (m.text = r.string()),
    3: (m, r) => (m.content = readSubmessage(r, decodeUserPromptContent))
  });
}

function decodeAgentText(bytes: Uint8Array): AgentText {
  return readMessage(bytes, { text: "" }, { 1: (m, r) => (m.text = r.string()) });
}

function decodeTitleUpdate(bytes: Uint8Array): TitleUpdate {
  return readMessage(bytes, { title: "" }, { 4: (m, r) => (m.title = r.string()) });
}

/**
 * Strip leading non-text bytes sometimes present before command output text
 * (truncation metadata / control chars from the wire format).
 */
export function sanitizeCommandOutput(raw: string): string {
  if (!raw) return raw;
  let start = 0;
  while (start < raw.length) {
    const code = raw.charCodeAt(start);
    // Keep normal whitespace; drop other C0 controls and DEL.
    if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f)) break;
    start += 1;
  }
  return raw.slice(start);
}

function decodeCommandResult(bytes: Uint8Array): CommandResult {
  return readMessage<CommandResult>(
    bytes,
    { cwd: "", exitCode: 0, output: "", command: "" },
    {
      2: (m, r) => (m.cwd = r.string()),
      6: (m, r) => (m.exitCode = readInt(r)),
      21: (m, r) => (m.output = sanitizeCommandOutput(r.string())),
      // 23 and 25 both carry the command line in observed DBs; prefer first non-empty.
      23: (m, r) => {
        const command = r.string();
        if (!m.command) m.command = command;
      },
      25: (m, r) => {
        const command = r.string();
        if (!m.command) m.command = command;
      }
    }
  );
}

export function decodeTaskDetails(bytes: Uint8Array): TaskDetails {
  return readMessage(bytes, { taskId: "", logUri: "", description: "" }, {
    1: (m, r) => (m.taskId = r.string()),
    2: (m, r) => (m.logUri = r.string()),
    4: (m, r) => (m.description = r.string())
  });
}

export function decodeStepPayload(bytes: Uint8Array): StepPayload {
  return readMessage<StepPayload>(
    bytes,
    {
      validityCheck: 0,
      toolRun: undefined,
      writeFile: undefined,
      grepSearch: undefined,
      viewFile: undefined,
      listDirectory: undefined,
      userPrompt: undefined,
      agentText: undefined,
      titleUpdate: undefined,
      commandResult: undefined
    },
    {
      1: (m, r) => (m.validityCheck = readInt(r)),
      5: (m, r) => (m.toolRun = readSubmessage(r, decodeToolRun)),
      10: (m, r) => (m.writeFile = readSubmessage(r, decodeWriteFileResult)),
      13: (m, r) => (m.grepSearch = readSubmessage(r, decodeGrepSearchResult)),
      14: (m, r) => (m.viewFile = readSubmessage(r, decodeViewFileResult)),
      15: (m, r) => (m.listDirectory = readSubmessage(r, decodeListDirectoryResult)),
      19: (m, r) => (m.userPrompt = readSubmessage(r, decodeUserPrompt)),
      20: (m, r) => (m.agentText = readSubmessage(r, decodeAgentText)),
      28: (m, r) => (m.commandResult = readSubmessage(r, decodeCommandResult)),
      30: (m, r) => (m.titleUpdate = readSubmessage(r, decodeTitleUpdate))
    }
  );
}
