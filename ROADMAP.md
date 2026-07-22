# ACP v1 roadmap

`agy-acp` covers the core ACP prompt loop (sessions, config options, streamed
tool calls, edit diffs, load/resume). Gaps below are relative to ACP v1 as
exposed by `@agentclientprotocol/sdk` and are ordered by practical editor UX.
Several items are constrained by wrapping `agy` and polling its conversation
database rather than driving agy as a full interactive agent.

## Done

- [x] `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/close`
- [x] `session/load` and `session/resume` with persisted bindings
- [x] `session/set_config_option` (`mode`, `model`, `reasoningEffort`)
- [x] `additionalDirectories` → `agy --add-dir`
- [x] Prompt content: text, image, embedded resource, resource link (`audio: false`)
- [x] Streamed `session/update`: `agent_message_chunk`, `agent_thought_chunk`,
      `user_message_chunk` (replay), progressive `tool_call` / `tool_call_update`,
      `session_info_update`
- [x] Tool kinds, locations, `rawInput` / `rawOutput`, edit content type `diff`
- [x] `session/list` from the session store
- [x] Execute tool output when present in the conversation DB (field 28)
- [x] Decode/show fetch and web-search result bodies when present in the DB
      (search_web hit lists are not persisted by agy; query metadata only)
- [x] Full-file write diffs with prior content when known from earlier view/write steps
- [x] Permission notes map decision varint to granted/denied labels
- [x] Experimental four-choice `run_command` permission bridge via persistent PTY

## High priority

These need more than conversation-DB polling (interactive agy control plane or
client terminal protocol) and are **out of scope for 0.2.x fidelity patches**:

- [ ] Expand interactive `session/request_permission` beyond the verified
      `run_command` menu (unsupported status-9 interactions currently fail closed)
- [ ] Structured `plan` / `plan_update` / `plan_removed` (today: brain/plan files are
      prose tool content with Plan titles — not ACP plan updates)
- [ ] Client terminals: `type: "terminal"` content + `terminal/*` (today: execute tools
      show command + captured output as content blocks, not live terminal protocol)
- [ ] ACP elicitation for `ask_question` (today: static tool_call text options)
- [ ] MCP: honor `session/new` `mcpServers` and advertise real `mcpCapabilities`
      (today: all MCP caps are `false` and servers are ignored)

## Medium priority

- [ ] Optional `session/delete` from the session store
- [ ] `session/fork` if/when useful for clients
- [ ] Native ACP session modes (`session/set_mode`, `modes`, `current_mode_update`)
      in addition to the `mode` config option that already maps to `agy --mode`
- [ ] `available_commands_update` for slash-command discovery in the client UI
- [ ] Push `config_option_update` when options change outside `set_config_option`
- [ ] `authenticate` / `logout` / `authMethods` (today: require a pre-logged-in `agy`)
- [ ] `usage_update` and prompt-response `usage` when token data is available
- [ ] Richer `stopReason` values (`max_tokens`, `refusal`, `max_turn_requests`) when
      agy exposes them (today: `end_turn` or `cancelled`)

## Fidelity improvements

- [x] Surface command stdout/stderr on execute tool calls when present in the DB
- [x] Decode/show fetch and web-search result bodies (not just URL / title)
- [x] Better diffs for full-file writes when prior content is knowable
- [x] Map permission decisions into granted/denied labels (not interactive outcomes)
- [ ] Agent-outbound images / richer content blocks when agy produces them

## Lower priority / unstable ACP

Usually skip unless a client needs them for this wrapper:

- [ ] `providers/*` (LLM provider routing UI)
- [ ] `nes/*` (next-edit suggestions)
- [ ] `document/*` (editor document sync)
- [ ] Agent-driven client `fs/read_text_file` / `fs/write_text_file` (agy does FS itself)
- [ ] Non-stdio transports (HTTP / WebSocket) — stdio NDJSON is intentional for Zed
