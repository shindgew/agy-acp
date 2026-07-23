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

Each checklist item uses **`[method_or_type](link): description`** with ACP wire
names (e.g. `session/new`, `tool_call_update`).

---

## ACP v1

Gaps relative to ACP v1 as exposed by `@agentclientprotocol/sdk`.

### Done

- [x] [`initialize`](https://agentclientprotocol.com/protocol/v1/initialization): version negotiation, agent info, capabilities
- [x] [`authMethods`](https://agentclientprotocol.com/protocol/v1/authentication): terminal `agy-login` + agent status methods advertised on initialize
- [x] [`authenticate`](https://agentclientprotocol.com/protocol/v1/authentication): confirms keyring login after terminal auth or existing session
- [x] [`logout`](https://agentclientprotocol.com/protocol/v1/authentication#logging-out): best-effort agy TUI `/logout` via PTY; `agentCapabilities.auth.logout`
- [x] [`auth_required`](https://agentclientprotocol.com/protocol/v1/authentication): returned on session new/load/resume when not signed into Antigravity
- [x] [`session/new`](https://agentclientprotocol.com/protocol/v1/session-setup): create session with persisted bindings
- [x] [`session/load`](https://agentclientprotocol.com/protocol/v1/session-setup): restore and replay conversation history
- [x] [`session/resume`](https://agentclientprotocol.com/rfds/session-resume): reattach without replaying history
- [x] [`session/close`](https://agentclientprotocol.com/rfds/session-close): close active session
- [x] [`session/list`](https://agentclientprotocol.com/protocol/v1/session-list): list sessions from the session store
- [x] [`session/prompt`](https://agentclientprotocol.com/protocol/v1/prompt-turn): send user prompt; full turn response with `stopReason`
- [x] [`session/cancel`](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation): interrupt turn (SIGINT then SIGKILL on agy)
- [x] [`session/set_config_option`](https://agentclientprotocol.com/protocol/v1/session-config-options): `mode`, `model`, `reasoningEffort` (select only)
- [x] [`session/set_mode`](https://agentclientprotocol.com/protocol/v1/session-modes): native modes; ids match config `mode` / `agy --mode`
- [x] [`modes`](https://agentclientprotocol.com/protocol/v1/session-modes): advertised on new/load/resume (`default` / `accept-edits` / `plan`)
- [x] [`current_mode_update`](https://agentclientprotocol.com/protocol/v1/session-modes): pushed when mode changes
- [x] [`config_option_update`](https://agentclientprotocol.com/protocol/v1/session-config-options): after `session/set_mode` and curated slash config changes
- [x] [`additionalDirectories`](https://agentclientprotocol.com/rfds/additional-directories): mapped to `agy --add-dir`
- [x] [`ContentBlock`](https://agentclientprotocol.com/protocol/v1/content): prompt text, image, embedded resource, resource link (`audio: false`)
- [x] [`agent_message_chunk`](https://agentclientprotocol.com/protocol/v1/content): streamed agent text
- [x] [`agent_thought_chunk`](https://agentclientprotocol.com/protocol/v1/content): streamed thoughts / title narration
- [x] [`user_message_chunk`](https://agentclientprotocol.com/protocol/v1/content): user message replay
- [x] [`messageId`](https://agentclientprotocol.com/rfds/message-id): optional on v1 message/thought chunks
- [x] [`tool_call`](https://agentclientprotocol.com/protocol/v1/tool-calls): first-sight tool call with kinds, locations, `rawInput` / `rawOutput`
- [x] [`tool_call_update`](https://agentclientprotocol.com/protocol/v1/tool-calls): progressive status/content updates
- [x] [`diff`](https://agentclientprotocol.com/protocol/v1/schema#diff): edit content type; full-file writes use prior content when known
- [x] [`session_info_update`](https://agentclientprotocol.com/rfds/session-info-update): titles from the conversation DB
- [x] [`session/request_permission`](https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission): interactive PTY bridge for `run_command` + file tools
- [x] [`fs/read_text_file`](https://agentclientprotocol.com/protocol/v1/file-system): client read-through when advertised
- [x] [`fs/write_text_file`](https://agentclientprotocol.com/protocol/v1/file-system): client write-through for editor review UI when advertised
- [x] [`tool_call`](https://agentclientprotocol.com/protocol/v1/tool-calls): execute tools surface command + captured stdout/stderr (DB field 28)
- [x] [`plan`](https://agentclientprotocol.com/protocol/v1/agent-plan): classic plan entries from brain markdown (checkbox status only)
- [x] [`available_commands_update`](https://agentclientprotocol.com/protocol/v1/slash-commands#advertising-commands): curated `mode` / `plan` / `model` / `effort` (config intercept, not agy TUI panels)

### High priority

Need interactive agy control plane or client terminal protocol beyond DB polling:

- [ ] [`session/request_permission`](https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission): expand for multi-select / multi-question `ask_question` and remaining status-9 tools (unsupported paths fail closed)
- [ ] [`terminal/create`](https://agentclientprotocol.com/protocol/v1/terminals): client-executed terminal suite (`output` / `release` / `wait_for_exit` / `kill` too) — blocked while agy owns the shell
- [ ] [`elicitation/create`](https://agentclientprotocol.com/rfds/elicitation): free-text / multi-select `ask_question` (+ `elicitation/complete`); single-select MCQ already uses `session/request_permission`
- [ ] [`mcpServers`](https://agentclientprotocol.com/rfds/mcp-over-acp): honor on `session/new`, real `mcpCapabilities`, route `mcp/message` · `mcp/connect` · `mcp/disconnect` when agy can consume external servers

### Medium priority

- [ ] [`session/delete`](https://agentclientprotocol.com/protocol/v1/session-delete): optional delete from the session store
- [ ] [`session/fork`](https://agentclientprotocol.com/rfds/session-fork): fork when useful for clients
- [ ] [`usage_update`](https://agentclientprotocol.com/rfds/session-usage): when token/usage data is available from agy
- [ ] [`usage`](https://agentclientprotocol.com/rfds/end-turn-token-usage): prompt-response field when available
- [ ] [`stopReason`](https://agentclientprotocol.com/protocol/v1/prompt-turn#stop-reasons): richer values (`max_tokens`, `refusal`, `max_turn_requests`) when agy exposes them (today: `end_turn` or `cancelled`)
- [ ] [`$/cancel_request`](https://agentclientprotocol.com/protocol/v1/cancellation): confirm SDK handling is enough; add explicit propagation only if clients need more

### Fidelity improvements

- [ ] [`name`](https://agentclientprotocol.com/rfds/tool-call-name): optional programmatic tool-call name alongside `title` / `kind` (unstable)
- [ ] [`ContentBlock`](https://agentclientprotocol.com/protocol/v1/content): agent-outbound images / richer blocks when agy produces them
- [ ] [`plan_update`](https://agentclientprotocol.com/rfds/plan-operations): unstable id-based plan ops (+ `plan_removed`) if a client prefers that over classic `plan`

### Lower priority / unstable ACP

Usually skip unless a client needs them for this wrapper:

- [ ] [`providers/list`](https://agentclientprotocol.com/rfds/custom-llm-endpoint): LLM provider routing (`providers/set`, `providers/disable` too)
- [ ] [`nes/start`](https://agentclientprotocol.com/rfds/next-edit-suggestions): next-edit suggestions (`suggest` / `accept` / `reject` / `close` too)
- [ ] [`document/didOpen`](https://agentclientprotocol.com/rfds/next-edit-suggestions): editor document sync (`didChange` / `didClose` / `didSave` / `didFocus`)
- [ ] [`positionEncoding`](https://agentclientprotocol.com/protocol/v1/schema): capability mainly for nes/document
- [ ] [Transports](https://agentclientprotocol.com/protocol/v1/transports): non-stdio HTTP / WebSocket ([streamable transport RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport)); stdio NDJSON is intentional for Zed

---

## ACP v2 (experimental draft)

Implemented via `@agentclientprotocol/sdk/experimental/v2`. The db/translator
layer still emits v1-shaped updates; `sessionUpdateToV2` maps them at the
protocol boundary. Shared backend gaps (permissions, MCP, plans, terminals)
apply to both protocol versions — listed here only when the **v2 wire shape**
differs or is incomplete.

### Done

- [x] [`initialize`](https://agentclientprotocol.com/protocol/v2/initialization): dual-protocol router from `protocolVersion`; role-agnostic `info` / `capabilities` ([migration](https://agentclientprotocol.com/protocol/v2/migration))
- [x] [`authMethods`](https://agentclientprotocol.com/protocol/v2/authentication): non-empty list (terminal + agent status)
- [x] [`auth/login`](https://agentclientprotocol.com/protocol/v2/authentication): same probe semantics as v1 `authenticate`
- [x] [`auth/logout`](https://agentclientprotocol.com/protocol/v2/authentication): same PTY `/logout` as v1 `logout`
- [x] [`session/new`](https://agentclientprotocol.com/protocol/v2/session-setup): create session
- [x] [`session/list`](https://agentclientprotocol.com/protocol/v2/session-list): list sessions
- [x] [`session/resume`](https://agentclientprotocol.com/protocol/v2/session-setup): optional `replayFrom: { "type": "start" }` ([replay RFD](https://agentclientprotocol.com/rfds/v2/session-resume-replay))
- [x] [`session/close`](https://agentclientprotocol.com/protocol/v2/session-setup): close session
- [x] [`session/prompt`](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle): accept with `{}` immediately
- [x] [`session/cancel`](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle): interrupt turn
- [x] [`session/update`](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle): progress notifications
- [x] [`state_update`](https://agentclientprotocol.com/protocol/v2/schema#stateupdate): `running` / `idle` + `stopReason`
- [x] [`session/set_config_option`](https://agentclientprotocol.com/protocol/v2/session-config-options): `configId` for `mode`, `model`, `reasoningEffort`
- [x] [`config_option_update`](https://agentclientprotocol.com/protocol/v2/session-config-options): when options change outside `set_config_option`
- [x] [`user_message`](https://agentclientprotocol.com/rfds/v2/message-updates): ack with agent-owned `messageId`
- [x] [`messageId`](https://agentclientprotocol.com/rfds/message-id): required on `agent_message_chunk` / `agent_thought_chunk` / `user_message_chunk`
- [x] [`tool_call_update`](https://agentclientprotocol.com/rfds/v2/tool-call-updates): upsert shape (first-sight collapsed from v1 `tool_call`); `cancelled` preserved
- [x] [`diff`](https://agentclientprotocol.com/rfds/v2/diff-file-states): `changes[]` + optional `git_patch` (`add` / `modify`, `fileType: "text"`)
- [x] [`session/request_permission`](https://agentclientprotocol.com/rfds/v2/permission-requests): `subject: { type: "tool_call", … }` + `title`
- [x] [`ContentBlock`](https://agentclientprotocol.com/protocol/v2/content): prompt caps `image`, `embeddedContext`
- [x] [`additionalDirectories`](https://agentclientprotocol.com/rfds/additional-directories): capability advertised
- [x] [`terminal_update`](https://agentclientprotocol.com/rfds/v2/terminal-output): agent-owned execute terminals + `type: "terminal"` embeds (DB snapshots)
- [x] [`plan_update`](https://agentclientprotocol.com/protocol/v2/agent-plan): brain plans ([`markdown`](https://agentclientprotocol.com/rfds/v2/plan-variants) preferred, else `items`); no `plan_removed`
- [x] [`available_commands_update`](https://agentclientprotocol.com/protocol/v2/slash-commands): same curated list + config intercept as v1

### High priority

- [ ] [`replayFrom`](https://agentclientprotocol.com/rfds/v2/session-resume-replay): richer cursors beyond `{ "type": "start" }` when the draft stabilizes incremental replay
- [ ] [`elicitation/create`](https://agentclientprotocol.com/rfds/elicitation): multi-select / free-text `ask_question` (+ `elicitation/complete`; today: fail closed)
- [ ] [`terminal_output_chunk`](https://agentclientprotocol.com/rfds/v2/terminal-output): incremental output while a command is still running (today: full snapshot when field 28 is present)
- [ ] [`tool_call_content_chunk`](https://agentclientprotocol.com/protocol/v2/schema#toolcallcontentchunk): progressive tool content while a call is running (today: only on `tool_call_update` snapshots)
- [ ] [`mcpServers`](https://agentclientprotocol.com/rfds/mcp-over-acp): honor session servers, advertise `capabilities.session.mcp`, route `mcp/*` when agy can consume them
- [ ] [`session/request_permission`](https://agentclientprotocol.com/rfds/v2/permission-requests): expand bridge to remaining agy menus once TUI channels are verified

### Medium priority

- [ ] [`session/delete`](https://agentclientprotocol.com/protocol/v2/session-delete): advertise and implement when useful
- [ ] [`session/fork`](https://agentclientprotocol.com/rfds/session-fork): when useful
- [ ] [`usage_update`](https://agentclientprotocol.com/rfds/session-usage): when token data is available from agy
- [ ] [`stopReason`](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle): richer values on idle `state_update` when agy exposes them
- [ ] [`agent_message`](https://agentclientprotocol.com/rfds/v2/message-updates): optional full-message updates (+ `agent_thought`) in addition to chunks
- [ ] [`$/cancel_request`](https://agentclientprotocol.com/protocol/v2/cancellation): confirm SDK handling (default vs explicit)

### Fidelity improvements

- [ ] [`name`](https://agentclientprotocol.com/rfds/tool-call-name): optional programmatic tool-call name alongside `title` / `kind`
- [ ] [`diff`](https://agentclientprotocol.com/rfds/diff-delete): `delete` / rename ops and richer [fileType](https://agentclientprotocol.com/rfds/v2/diff-file-states) when agy exposes them
- [ ] [`ContentBlock`](https://agentclientprotocol.com/protocol/v2/content): agent-outbound images / richer blocks when agy produces them

### Draft tracking

- [ ] [`@agentclientprotocol/sdk`](https://agentclientprotocol.com/announcements/acp-v2-draft): keep pace with experimental/v2 breaking changes until the draft freezes
- [ ] [`alpha`](https://agentclientprotocol.com/protocol/v2/migration): promote dual-protocol support off the alpha track when the draft freezes
- [ ] [`tool_call_update`](https://agentclientprotocol.com/rfds/v2/tool-call-updates): drop or narrow v1-shaped internal builders if stable v2-native updates become the default

### Out of scope (unless a client requires them)

Not advertised in `initialize` capabilities:

- [ ] [`providers/*`](https://agentclientprotocol.com/rfds/custom-llm-endpoint): provider routing UI
- [ ] [`nes/*`](https://agentclientprotocol.com/rfds/next-edit-suggestions): next-edit suggestions
- [ ] [`document/*`](https://agentclientprotocol.com/rfds/next-edit-suggestions): document sync (+ `positionEncoding`)
- [ ] [`fs/*`](https://agentclientprotocol.com/rfds/v2/client-filesystem-terminal-capabilities): agent-driven client filesystem (draft v2 has no client `fs/*`; agy owns FS)
- [ ] [Transports](https://agentclientprotocol.com/protocol/v2/transports): non-stdio [HTTP / WebSocket / SSE](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport)
- [ ] [JSON-RPC batch](https://agentclientprotocol.com/protocol/v2/transports): batch framing beyond what the SDK implements for the chosen transport
