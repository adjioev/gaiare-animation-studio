# GS-10: Studio — MCP bridge + function-calling loop

**Phase:** 4
**Effort:** 2 days
**Depends on:** GS-3 (Rails token in keychain) — uses same auth
**Repo:** `gaiare-project/gaiare-animation-studio` (Tauri/React)

## Summary

Bridge Studio's chat panel (Kimi K2.6 on Fireworks) to the Rails MCP
server. Kimi can call MCP tools (`SearchQuestions`, `GetQuestion`,
`ListTopics`, etc.) mid-conversation to ground its responses in the
actual project state — "the user is iterating on Q14, let me look up
similar procedural questions about right-of-way to find a working
prompt pattern".

## Architecture

```
Studio (Tauri)
  ├─ Rust MCP client (rails_mcp.rs) — HTTP/SSE to Rails MCP server
  └─ JS chat loop (llm.ts)
      ├─ assembles `tools: [...]` per request (4-6 relevant tools)
      ├─ Fireworks → Kimi response with `tool_calls: [...]`
      ├─ for each tool_call → invoke Rust → MCP server → result
      ├─ append `role: "tool", tool_call_id, content` messages
      └─ loop until Kimi sends non-tool-call response (cap: 5 rounds)
```

## Acceptance criteria

- [ ] Rust module `src-tauri/src/rails_mcp.rs`:
  - `rails_mcp_call(tool_name: String, arguments: Value) -> Result<Value>`
  - Reads Rails server URL + token from keychain (same as
    `src-tauri/src/rails.rs`)
  - POST to `<rails>/mcp/tools/<tool_name>/call` (or whatever Rails MCP
    server exposes — confirm the actual route by running the
    `bin/rails routes | grep mcp` once)
  - Auth: `Authorization: Bearer <token>`
  - Timeout: 5 seconds. On timeout → return synthetic
    `{ "error": "mcp_unavailable" }` JSON so Kimi can adapt rather than
    retry into a dead endpoint (architect)
  - Errors normalized to JSON shape so Kimi sees `{ error: "...", code: "..." }`
- [ ] JS-side `mcpToolsForContext(activeTab, workspace, history)` helper
      in `src/lib/llm.ts` selects 4-6 most-relevant tools to send per
      request (architect's "tool schema size" note):
  - Always include: `SearchQuestions`, `GetQuestion`
  - For Generate tab with prompt iteration in progress: add
    `ListTopics`, `GetCategory`
  - For Stitch tab: add `SimilarQuestions` if exists
  - When Kimi calls an unincluded tool: return error JSON so it adapts
    — don't auto-expand silently
- [ ] Tool schema format follows OpenAI's function-calling spec
      (Fireworks compatible):
  ```ts
  type Tool = {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: { type: "object"; properties: {...}; required: [...] };
    };
  };
  ```
- [ ] Schemas live in `src/lib/mcp-tools.ts` — hand-written per tool
      based on Rails MCP server's introspection. Architect's reasoning:
      auto-pulling schemas from MCP adds bytes; hand-writing forces us
      to keep only what Kimi actually uses well.
- [ ] `chat()` in `src/lib/llm.ts` extends to support tool calls:
  - Accepts `tools?: Tool[]` opt
  - Returns `tool_calls?: ToolCall[]` when Kimi requests them (in
    addition to the usual `text`)
- [ ] `ChatPanel.send()` loop:
  1. Build tools via `mcpToolsForContext(...)`
  2. Call `chat([...history, userMsg], { tools, attachImageDataUri })`
  3. If response has `tool_calls`:
     a. For each call: `invoke("rails_mcp_call", { tool_name, arguments })`
        with 5-sec timeout
     b. Append assistant `tool_calls` message + each tool result as a
        `role: "tool"` message to wire history (NOT persisted in
        workspace.chat — too noisy; just in the in-flight request
        history)
     c. Re-call `chat(...)` with updated history
     d. Repeat until non-tool-call response, max 5 rounds
  4. On reaching cap: append synthetic assistant message "Stopped
     looking up details after 5 rounds — let me know if you want me to
     keep searching" + persist that as a normal assistant turn
- [ ] Loop iteration UI: status pill cycles `"Looking up Q14…" → "Searching
      procedural questions…" → "Thinking…"` based on tool call names
- [ ] Persisted `ChatMessage` types unchanged — tool roundtrips are
      ephemeral. The user-visible assistant message is the LAST one (the
      non-tool-call result). Tool intermediate messages stay in wire
      history but never workspace.json
- [ ] Failure resilience:
  - MCP unavailable → tool call returns error JSON → Kimi acknowledges
    "I can't look that up right now" in its text response
  - Tool returns malformed JSON → Kimi sees error JSON
  - Rails 401 (token expired) → all tools fail with `rails_auth_expired`
    → JS surfaces a one-time "Reconnect to Rails to use MCP tools" toast,
    next chat round skips tool list entirely

## Implementation notes

- Reusing `rails.rs` keychain code (GS-3) keeps token handling in one
  place.
- For the 5-round cap: count is per-user-turn, not lifetime. Resets on
  each fresh user input.
- Tool result truncation: if a tool returns 20KB of JSON (e.g.
  SearchQuestions with 50 results), inflate token usage. Truncate each
  tool result to ~2K tokens worth — for SearchQuestions specifically,
  return only top 5 hits with short fields. Done in `mcp-tools.ts`
  per-tool post-processing.
- The Rails MCP server route may be at `/mcp/...` or under a plugin
  subpath. Verify with `bin/rails routes | grep mcp` before coding.
- Architect's mention: existing `cognitive_type` enum values are
  `textual / situational / procedural / signquiz / medical` — make sure
  tool schemas reflect those exactly.

## Files touched

**New:**
- `src-tauri/src/rails_mcp.rs` — Rust MCP client
- `src/lib/mcp-tools.ts` — tool schemas + post-processing
- (maybe) `src/lib/mcp-bridge.ts` — loop helper extracted from
  ChatPanel for testability

**Modified:**
- `src-tauri/src/lib.rs` — register `rails_mcp_call`
- `src/lib/llm.ts` — `chat()` accepts `tools`, returns `tool_calls`
- `src/components/ChatPanel.tsx` — tool-call loop in `send()` with
  iteration UI

## Test plan

- [ ] Studio connected to Rails. Open chat panel.
- [ ] Send "Tell me about Q14"
- [ ] Verify (via DevTools / dev logs): Kimi requests
      `SearchQuestions({external_ref: "14"})` or `GetQuestion("GE/14")`
- [ ] Studio invokes the tool, Rails MCP returns Q14 data
- [ ] Kimi response includes specifics from Rails (image description,
      cognitive_type, etc.) — proves the tool result was injected
- [ ] Send "Find me similar questions" → Kimi calls SearchQuestions →
      Kimi summarises the results
- [ ] Disconnect Rails. Send a chat message → tool calls fail with
      `mcp_unavailable` → Kimi responds with general advice + "I can't
      reach Rails right now"
- [ ] Force Kimi into an infinite loop scenario (impossible naturally,
      manual: have it call same tool 6 times) → cap kicks in, synthetic
      "I've stopped searching" message
- [ ] Verify `workspace.chat` does NOT bloat with tool roundtrips —
      only user + final assistant messages persist
- [ ] Generate clip with chat-suggested prompt → Kimi can call
      `GetQuestion` mid-iteration to remember details

## Out of scope

- Streaming responses from MCP (tool result arrives all-at-once)
- Per-tool ACL beyond admin token (any admin can call any tool)
- Tool-call history visualisation in chat bubble (might add later if
  user asks "why did you look that up?")
- Other LLM providers (Anthropic / OpenAI) — Fireworks-only for now
