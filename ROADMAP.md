# Roadmap

`agy-acp` covers the core ACP prompt loop (sessions, config options, streamed
tool calls, edit diffs, load/resume). It serves **ACP v1** and **experimental
draft ACP v2** side by side via `initialize` version negotiation
(`agentProtocolRouter`). Gaps are ordered by practical editor UX and constrained
by wrapping `agy` and polling its conversation database rather than driving agy
as a full interactive agent.

Draft ACP v2 tracks the `alpha` dist-tag (`1.0.0-alpha.*`). The wire protocol may
still change before stabilization — see the
[ACP v2 draft](https://agentclientprotocol.com/announcements/acp-v2-draft) and
[Migrating from v1](https://agentclientprotocol.com/protocol/v2/migration).

Protocol surface is tracked against `@agentclientprotocol/sdk` (full
[v1 schema](https://agentclientprotocol.com/protocol/v1/schema) /
[v2 schema](https://agentclientprotocol.com/protocol/v2/schema)), not only the
abbreviated [v1 Overview](https://agentclientprotocol.com/protocol/v1/overview) /
[v2 Overview](https://agentclientprotocol.com/protocol/v2/overview) pages.

---

## ACP v1

Gaps relative to ACP v1 as exposed by `@agentclientprotocol/sdk`.

### Done

- [x] [`initialize`](https://agentclientprotocol.com/protocol/v1/initialization),
      [`session/new`](https://agentclientprotocol.com/protocol/v1/session-setup),
      [`session/prompt`](https://agentclientprotocol.com/protocol/v1/prompt-turn),
      [`session/cancel`](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation),
      [`session/close`](https://agentclientprotocol.com/rfds/session-close)
- [x] [`session/load`](https://agentclientprotocol.com/protocol/v1/session-setup)
      and [`session/resume`](https://agentclientprotocol.com/rfds/session-resume)
      with persisted bindings
- [x] [`session/set_config_option`](https://agentclientprotocol.com/protocol/v1/session-config-options)
      (`mode`, `model`, `reasoningEffort`) — select options only (no
      [boolean config options](https://agentclientprotocol.com/rfds/boolean-config-option) yet)
- [x] Native [session modes](https://agentclientprotocol.com/protocol/v1/session-modes):
      `modes` on new/load/resume,
      [`session/set_mode`](https://agentclientprotocol.com/protocol/v1/schema#session/set_mode),
      [`current_mode_update`](https://agentclientprotocol.com/protocol/v1/session-modes)
      (ids match config `mode` / `agy --mode`)
- [x] [`config_option_update`](https://agentclientprotocol.com/protocol/v1/session-config-options)
      when mode changes via `session/set_mode`
- [x] [`additionalDirectories`](https://agentclientprotocol.com/rfds/additional-directories)
      → `agy --add-dir`
- [x] [Prompt content](https://agentclientprotocol.com/protocol/v1/content): text,
      image, embedded resource, resource link (`audio: false`)
- [x] Streamed [`session/update`](https://agentclientprotocol.com/protocol/v1/prompt-turn#3-agent-reports-output):
      [`agent_message_chunk`](https://agentclientprotocol.com/protocol/v1/content) /
      [`agent_thought_chunk`](https://agentclientprotocol.com/protocol/v1/content) /
      [`user_message_chunk`](https://agentclientprotocol.com/protocol/v1/content)
      (replay), progressive
      [`tool_call`](https://agentclientprotocol.com/protocol/v1/tool-calls) /
      [`tool_call_update`](https://agentclientprotocol.com/protocol/v1/tool-calls),
      [`session_info_update`](https://agentclientprotocol.com/rfds/session-info-update)
- [x] Optional [`messageId`](https://agentclientprotocol.com/rfds/message-id) on
      v1 message/thought chunks (same ids the v2 boundary requires; optional in
      v1, required in draft v2)
- [x] Tool kinds, locations, `rawInput` / `rawOutput`, edit content type
      [`diff`](https://agentclientprotocol.com/protocol/v1/schema#diff)
- [x] [`session/list`](https://agentclientprotocol.com/protocol/v1/session-list)
      from the session store
- [x] Execute tool output when present in the conversation DB (field 28)
- [x] Decode/show fetch and web-search result bodies when present in the DB
      (search_web hit lists are not persisted by agy; query metadata only)
- [x] Full-file write diffs with prior content when known from earlier view/write steps
- [x] Permission notes map decision varint to granted/denied labels
- [x] Experimental interactive
      [`session/request_permission`](https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission)
      bridge via persistent PTY for the four-choice menu (`run_command` + file
      tools sharing ToolConfirmationPanel)
- [x] Agent-driven client
      [`fs/read_text_file`](https://agentclientprotocol.com/protocol/v1/file-system) /
      [`fs/write_text_file`](https://agentclientprotocol.com/protocol/v1/file-system):
      when the client advertises both, every completed edit is routed through
      them — whether it landed on disk without a live agy gate (accept-edits) or
      just passed one (default mode, after the live permission prompt) — so the
      client's own diff/review UI (e.g. Zed's Review Changes panel) tracks it in
      either mode. Falls back to the local permission bridge if the client lacks
      the capability or rejects the write-through.
- [x] Execute tools surface command + captured output as content blocks (v1) and
      draft-v2 agent-owned
      [`terminal_update`](https://agentclientprotocol.com/rfds/v2/terminal-output) +
      `type: "terminal"` embeds
- [x] Structured plan from brain markdown artifacts: **classic** v1
      [`plan`](https://agentclientprotocol.com/protocol/v1/agent-plan)
      (checklist entries only — not the unstable id-based v1
      [`plan_update`](https://agentclientprotocol.com/rfds/plan-operations) /
      `plan_removed` shape) and draft-v2
      [`plan_update`](https://agentclientprotocol.com/protocol/v2/agent-plan)
      (`markdown` when body is known, else `items`). Status only reflects
      checkbox markers in the file — no live task progress from agy. Neither
      protocol emits `plan_removed` (agy does not delete plans).
- [x] [`available_commands_update`](https://agentclientprotocol.com/protocol/v1/slash-commands#advertising-commands):
      curated ACP slash commands for agy (`mode`, `plan`, `model`, `effort`)
      on new/load/resume; `/mode` · `/plan` · `/model` · `/effort` map to
      session config (not agy TUI panels)

### High priority

These need more than conversation-DB polling (interactive agy control plane or
client terminal protocol) and are **out of scope for 0.2.x fidelity patches**:

- [ ] Expand interactive
      [`session/request_permission`](https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission)
      (multi-select / multi-question `ask_question`, remaining status-9 tools;
      unsupported status-9 interactions currently fail closed)
- [ ] v1 client-executed
      [`terminal/*`](https://agentclientprotocol.com/protocol/v1/terminals) suite
      ([`terminal/create`](https://agentclientprotocol.com/protocol/v1/schema#terminal/create),
      [`terminal/output`](https://agentclientprotocol.com/protocol/v1/schema#terminal/output),
      [`terminal/release`](https://agentclientprotocol.com/protocol/v1/schema#terminal/release),
      [`terminal/wait_for_exit`](https://agentclientprotocol.com/protocol/v1/schema#terminal/wait_for_exit),
      [`terminal/kill`](https://agentclientprotocol.com/protocol/v1/schema#terminal/kill)).
      Blocked while agy owns the shell — re-running would double-execute. v1 keeps
      content blocks; draft v2 uses agent-owned terminals (see below).
- [ ] ACP [Elicitation](https://agentclientprotocol.com/rfds/elicitation) for
      free-text / multi-select `ask_question`: client `elicitation/create` +
      `elicitation/complete` (single-select MCQ already uses
      [`session/request_permission`](https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission);
      today unsupported paths fail closed)
- [ ] [MCP-over-ACP](https://agentclientprotocol.com/rfds/mcp-over-acp): honor
      `session/new` `mcpServers`, advertise real `mcpCapabilities`
      (`http` / `sse` / `acp` as supported), and route wire methods if/when agy
      can consume external servers — agent `mcp/message`, client `mcp/connect`,
      `mcp/message`, `mcp/disconnect` (today: all MCP caps are `false` and
      servers are ignored)

### Medium priority

- [ ] Optional [`session/delete`](https://agentclientprotocol.com/protocol/v1/session-delete)
      from the session store
- [ ] [`session/fork`](https://agentclientprotocol.com/rfds/session-fork) if/when
      useful for clients
- [x] Native ACP [session modes](https://agentclientprotocol.com/protocol/v1/session-modes)
      (`session/set_mode`, `modes`, `current_mode_update`) in addition to the
      `mode` config option that already maps to `agy --mode` (same three ids:
      `default` / `accept-edits` / `plan`). Draft v2 has no `set_mode` surface —
      mode stays a config option there.
- [x] [`available_commands_update`](https://agentclientprotocol.com/protocol/v1/slash-commands#advertising-commands)
      for slash-command discovery: curated ACP commands adapted for agy
      (`mode`, `plan`, `model`, `effort`) on new/load/resume; prompts like
      `/mode plan` are handled as config changes (no agy TUI panels)
- [x] Push [`config_option_update`](https://agentclientprotocol.com/protocol/v1/session-config-options)
      when options change outside `set_config_option` (v1: after `session/set_mode`;
      `set_config_option` still returns the full list in its response and pushes
      `current_mode_update` when mode changes)
- [ ] [`authenticate`](https://agentclientprotocol.com/protocol/v1/authentication) /
      [`logout`](https://agentclientprotocol.com/protocol/v1/authentication#logging-out) /
      `authMethods` (today: require a pre-logged-in `agy`)
- [ ] [`usage_update`](https://agentclientprotocol.com/rfds/session-usage) and
      prompt-response [`usage`](https://agentclientprotocol.com/rfds/end-turn-token-usage)
      when token data is available
- [ ] Richer [`stopReason`](https://agentclientprotocol.com/protocol/v1/prompt-turn#stop-reasons)
      values (`max_tokens`, `refusal`, `max_turn_requests`) when agy exposes them
      (today: `end_turn` or `cancelled`)
- [ ] Confirm [`$/cancel_request`](https://agentclientprotocol.com/protocol/v1/cancellation)
      (protocol-level request cancellation, separate from
      [`session/cancel`](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation))
      is handled by the SDK connection layer for in-flight agent requests; add
      explicit propagation only if clients need it beyond SDK defaults

### Fidelity improvements

- [x] Surface command stdout/stderr on execute tool calls when present in the DB
- [x] Decode/show fetch and web-search result bodies (not just URL / title)
- [x] Better diffs for full-file writes when prior content is knowable
- [x] Map permission decisions into granted/denied labels (not interactive outcomes)
- [ ] Optional tool-call [`name`](https://agentclientprotocol.com/rfds/tool-call-name)
      (programmatic tool id) alongside `title` / `kind` when agy metadata is
      available (schema field still marked unstable)
- [ ] Agent-outbound images / richer
      [content blocks](https://agentclientprotocol.com/protocol/v1/content)
      when agy produces them
- [ ] Unstable id-based v1
      [`plan_update` / `plan_removed`](https://agentclientprotocol.com/rfds/plan-operations)
      (and client `plan` cap) if a client prefers that shape over classic
      [`plan`](https://agentclientprotocol.com/protocol/v1/agent-plan) entries

### Lower priority / unstable ACP

Usually skip unless a client needs them for this wrapper:

- [ ] [`providers/*`](https://agentclientprotocol.com/rfds/custom-llm-endpoint)
      (`providers/list`, `providers/set`, `providers/disable`)
- [ ] [`nes/*`](https://agentclientprotocol.com/rfds/next-edit-suggestions)
      (`nes/start`, `nes/suggest`, `nes/accept`, `nes/reject`, `nes/close`)
- [ ] `document/*` (`document/didOpen`, `didChange`, `didClose`, `didSave`,
      `didFocus`) — editor document sync (often paired with NES)
- [ ] `positionEncoding` capability (relevant mainly with nes/document surfaces)
- [ ] Non-stdio [transports](https://agentclientprotocol.com/protocol/v1/transports)
      ([HTTP / WebSocket](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport))
      — stdio NDJSON is intentional for Zed

---

## ACP v2 (experimental draft)

Implemented via `@agentclientprotocol/sdk/experimental/v2`. The db/translator
layer still emits v1-shaped updates; `sessionUpdateToV2` maps them at the
protocol boundary. Shared backend gaps (permissions, MCP, plans, terminals)
apply to both protocol versions — listed here only when the **v2 wire shape**
differs or is incomplete.

### Done

- [x] Dual-protocol router: negotiate v1 vs draft v2 from
      [`initialize.protocolVersion`](https://agentclientprotocol.com/protocol/v2/initialization)
- [x] Role-agnostic `info` / `capabilities` on
      [`initialize`](https://agentclientprotocol.com/protocol/v2/initialization)
      (no `agentInfo` / `agentCapabilities` split) — see
      [Migrating from v1](https://agentclientprotocol.com/protocol/v2/migration)
- [x] Baseline session methods:
      [`session/new`](https://agentclientprotocol.com/protocol/v2/session-setup),
      [`session/list`](https://agentclientprotocol.com/protocol/v2/session-list),
      [`session/resume`](https://agentclientprotocol.com/protocol/v2/session-setup),
      [`session/close`](https://agentclientprotocol.com/protocol/v2/session-setup),
      [`session/prompt`](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle),
      [`session/cancel`](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle),
      [`session/update`](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle)
- [x] [`session/set_config_option`](https://agentclientprotocol.com/protocol/v2/session-config-options)
      with `configId` (v1 still uses `id`) for `mode`, `model`, `reasoningEffort`
- [x] [Prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle):
      accept with `{}` immediately; progress via
      [`state_update`](https://agentclientprotocol.com/protocol/v2/schema#stateupdate)
      (`running` / `idle` + `stopReason`)
- [x] User-message ack:
      [`user_message`](https://agentclientprotocol.com/rfds/v2/message-updates)
      update with agent-owned `messageId`
- [x] Required [`messageId`](https://agentclientprotocol.com/rfds/message-id) on
      `agent_message_chunk` / `agent_thought_chunk` / `user_message_chunk`
- [x] [`session/resume`](https://agentclientprotocol.com/rfds/v2/session-resume-replay)
      with optional `replayFrom: { "type": "start" }` (replaces v1
      `session/load`; omit `replayFrom` to reattach without replay)
- [x] Collapse first-sight `tool_call` → v2
      [`tool_call_update`](https://agentclientprotocol.com/rfds/v2/tool-call-updates)
      (upsert shape)
- [x] Structured [diff](https://agentclientprotocol.com/rfds/v2/diff-file-states)
      content: `changes[]` + optional `git_patch` patch block
      (`operation: "add" | "modify"`, `fileType: "text"` for known text edits)
- [x] Tool status `cancelled` preserved for v2 (mapped to `failed` for v1)
- [x] [`session/request_permission`](https://agentclientprotocol.com/rfds/v2/permission-requests)
      with v2 `subject: { type: "tool_call", … }` + `title` (same interactive
      bridge as v1)
- [x] Prompt caps advertised: `image`, `embeddedContext`;
      [`additionalDirectories`](https://agentclientprotocol.com/rfds/additional-directories)
      capability
- [x] Agent-owned
      [`terminal_update`](https://agentclientprotocol.com/rfds/v2/terminal-output)
      for execute tools (command / cwd / output snapshot / exitStatus) plus
      `type: "terminal"` tool content embed. Output is DB field-28 snapshots
      (and progressive tool updates), not a live client PTY byte stream.
- [x] [`plan_update`](https://agentclientprotocol.com/protocol/v2/agent-plan)
      for brain plan artifacts
      ([`type: "markdown"`](https://agentclientprotocol.com/rfds/v2/plan-variants)
      preferred; `type: "items"` fallback). No `plan_removed` (agy does not
      delete plans).

### High priority

Wire-shape and lifecycle work specific to draft v2 (or required for parity with
v2-aware clients):

- [ ] Richer [`replayFrom`](https://agentclientprotocol.com/rfds/v2/session-resume-replay)
      cursors beyond `{ "type": "start" }` when the draft stabilizes incremental
      replay
- [ ] Map multi-select / free-text `ask_question` to client
      [Elicitation](https://agentclientprotocol.com/rfds/elicitation)
      (`elicitation/create` + `elicitation/complete`; today: fail closed; static
      tool_call text only)
- [ ] Incremental
      [`terminal_output_chunk`](https://agentclientprotocol.com/rfds/v2/terminal-output)
      while a command is still running, if agy ever persists partial stdout
      before completion (today: full `terminal_update.output` snapshot when
      field 28 is present)
- [ ] Incremental
      [`tool_call_content_chunk`](https://agentclientprotocol.com/protocol/v2/schema#toolcallcontentchunk)
      for progressive tool content while a call is still running (today: content
      arrives only on
      [`tool_call_update`](https://agentclientprotocol.com/rfds/v2/tool-call-updates)
      snapshots from the DB — same limitation as full terminal snapshots)
- [ ] [MCP-over-ACP](https://agentclientprotocol.com/rfds/mcp-over-acp): honor
      session `mcpServers`, advertise `capabilities.session.mcp`, and route
      `mcp/*` if/when agy can consume external MCP servers — agent `mcp/message`,
      client `mcp/connect` / `mcp/message` / `mcp/disconnect`
- [ ] Expand interactive
      [permission](https://agentclientprotocol.com/rfds/v2/permission-requests)
      bridge to any remaining agy menus once their TUI/response channels are
      verified

### Medium priority

- [ ] Advertise and implement
      [`session/delete`](https://agentclientprotocol.com/protocol/v2/session-delete) /
      [`session/fork`](https://agentclientprotocol.com/rfds/session-fork) when useful
- [x] Push [`config_option_update`](https://agentclientprotocol.com/protocol/v2/session-config-options)
      when options change outside `set_config_option` (v1 `set_mode` path; draft
      v2 has no set_mode — response still returns full options on
      set_config_option)
- [x] [`available_commands_update`](https://agentclientprotocol.com/protocol/v2/slash-commands)
      for slash-command discovery (same curated list + config intercept as v1)
- [ ] [`auth/login`](https://agentclientprotocol.com/protocol/v2/authentication) /
      [`auth/logout`](https://agentclientprotocol.com/protocol/v2/authentication) +
      non-empty `authMethods` (today: empty list; require pre-logged-in `agy`)
- [ ] [`usage_update`](https://agentclientprotocol.com/rfds/session-usage) when
      token/usage data is available from agy
- [ ] Richer `stopReason` on idle
      [`state_update`](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle)
      (`max_tokens`, `refusal`, `max_turn_requests`) when agy exposes them
- [ ] Optional full-message updates
      ([`agent_message`](https://agentclientprotocol.com/rfds/v2/message-updates) /
      [`agent_thought`](https://agentclientprotocol.com/rfds/v2/message-updates))
      in addition to chunk streaming, if clients prefer them
- [ ] Confirm [`$/cancel_request`](https://agentclientprotocol.com/protocol/v2/cancellation)
      handling (same as v1 — SDK default vs explicit)

### Fidelity improvements

- [ ] Optional tool-call [`name`](https://agentclientprotocol.com/rfds/tool-call-name)
      alongside `title` / `kind` when known
- [ ] Diff
      [`delete`](https://agentclientprotocol.com/rfds/diff-delete) /
      rename-style path ops (and richer
      [`fileType`](https://agentclientprotocol.com/rfds/v2/diff-file-states)s)
      when agy exposes deletes or non-text edits — today only `add` / `modify` +
      text
- [ ] Agent-outbound images / richer
      [content blocks](https://agentclientprotocol.com/protocol/v2/content)
      when agy produces them

### Draft tracking

- [ ] Keep pace with `@agentclientprotocol/sdk` experimental/v2 breaking changes
      until ACP v2 stabilizes; pin and re-test on each SDK bump
- [ ] Promote dual-protocol support off the `alpha` track when the draft freezes
- [ ] Drop or narrow v1-shaped internal builders if a stable v2-native update
      model becomes the default path

### Out of scope (unless a client requires them)

Same as v1 lower-priority surface; not advertised in `initialize` capabilities:

- [ ] [`providers/*`](https://agentclientprotocol.com/rfds/custom-llm-endpoint),
      [`nes/*`](https://agentclientprotocol.com/rfds/next-edit-suggestions),
      `document/*`, `positionEncoding`
- [ ] Agent-driven client filesystem methods (draft v2 has no `fs/*` client
      methods today; see
      [v2 Client Filesystem and Terminal Execution Surface](https://agentclientprotocol.com/rfds/v2/client-filesystem-terminal-capabilities);
      agy owns FS either way)
- [ ] Non-stdio [transports](https://agentclientprotocol.com/protocol/v2/transports)
      ([HTTP / WebSocket / SSE](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport))
- [ ] JSON-RPC batch framing nuances beyond what the SDK already implements for
      the chosen transport (see
      [Transports](https://agentclientprotocol.com/protocol/v2/transports))
