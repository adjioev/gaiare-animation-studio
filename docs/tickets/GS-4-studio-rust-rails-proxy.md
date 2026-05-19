# GS-4: Studio — Rust Rails proxy commands

**Phase:** 1
**Effort:** 0.5 day
**Depends on:** GS-2 (Rails endpoints) + GS-3 (token in keychain)
**Repo:** `gaiare-project/gaiare-animation-studio` (Tauri/React)

## Summary

Rust-side Tauri commands that proxy authenticated requests to the Rails
Studio API. Mirrors the existing `replicate.rs` and `llm.rs` pattern —
token lives only in the Rust process, never reaches the JS bundle. TS
side gets `listQuestions(filters)`, `getQuestion(id)`, `listCountries()`
helpers that return parsed types.

## Why proxy through Rust (not fetch from JS)

Same threat model as Replicate / Fireworks proxies: a malicious tab or
renderer dependency could exfiltrate the bearer token if it lived in the
WebView. Rust holds it, validates host on every call, makes the request
on JS's behalf.

## Acceptance criteria

- [ ] `src-tauri/src/rails.rs` module with three Tauri commands:
  - `rails_list_questions(query: serde_json::Value) -> Vec<Value> + Meta`
  - `rails_get_question(id: String) -> Value`
  - `rails_list_countries() -> Vec<Value>`
- [ ] All three read the Rails server URL + token from keychain (via
      helpers from GS-3's `rails_auth.rs`). Returns `Err` with clear
      message if not connected.
- [ ] Strict authority check on the server URL — `url::Url::parse` →
      `scheme == "https"` OR `scheme == "http"` AND `host_str` is
      `localhost` or `127.0.0.1` (allow local dev). Reject anything else
      to prevent token leak to attacker host.
- [ ] Auth header: `Authorization: Bearer <token>` set on every request.
      User-agent: `gaiare-animation-studio/<version>`.
- [ ] Error mapping:
  - 401 → distinct error `"rails_auth_expired"` so JS can surface a
    "Reconnect" CTA in SettingsModal
  - 403 → `"rails_forbidden"`
  - 404 → `"rails_not_found"`
  - 5xx → `"rails_server_error"` with body excerpt
  - Network error → `"rails_unreachable"`
- [ ] Timeout: 10 seconds per request. Cancellable via `AbortSignal` in JS
      → Rust drops the future when JS abandons it.
- [ ] `src/lib/rails.ts` adds typed wrappers:
  ```ts
  export interface QuestionSummary { id: number; external_ref: string; country_code: string; image_url: string; cognitive_type: string; answer_video_url: string | null; ... }
  export async function listQuestions(filters: QuestionFilters): Promise<{ data: QuestionSummary[]; meta: Meta }>
  export async function getQuestion(idOrComposite: string): Promise<QuestionDetail>
  export async function listCountries(): Promise<Country[]>
  ```
- [ ] Each TS wrapper handles the `rails_auth_expired` error case by
      surfacing it to the parent — does NOT auto-disconnect (UI decides
      what to do).
- [ ] Tests: at minimum, manual cURL parity. Unit tests in Rust for the
      URL validator are nice-to-have.

## Implementation notes

- Pattern to copy: `src-tauri/src/replicate.rs` `request_json` helper +
  `is_replicate_url` authority check.
- Use `reqwest::Client::builder().timeout(Duration::from_secs(10))` for
  network timeout.
- Body parsing: `res.json::<Value>().await?` — keep parse generic in
  Rust; TS wrappers do typed casts.
- Query params: `reqwest::RequestBuilder::query(&params)` accepts a
  `&[(&str, &str)]` slice OR a serde struct. Pick whichever is cleanest
  for JS-passed query objects.
- Token retrieval: never log or print the token, even in eprintln
  diagnostics.

## Files touched

**New:**
- `src-tauri/src/rails.rs` — proxy commands
- `src/lib/rails.ts` — typed wrappers (adds to file from GS-3 if it
  exists, otherwise creates)

**Modified:**
- `src-tauri/src/lib.rs` — register commands in `invoke_handler!`

## Test plan

- [ ] Manual: in DevTools console, after connecting Studio to Rails:
      ```js
      await window.__TAURI__.core.invoke("rails_list_questions", { query: { country_code: "GE", per_page: 3 } })
      ```
      returns parsed `{ data, meta }`
- [ ] Same with disconnected Studio → error `rails_unreachable` (no token)
- [ ] Revoke token via Rails Avo, retry call → error `rails_auth_expired`
- [ ] Point at `http://attacker.com` via SettingsModal — Rust rejects
      with "untrusted host" before sending any token
- [ ] Slow Rails response (`sleep 15` injected in dev) → JS sees timeout
      error at 10s
- [ ] AbortSignal cancellation: start `listQuestions` then abort
      immediately → Rust future is dropped, no leak

## Out of scope

- POST endpoints (publish flow lives in GS-8 and uses its own command)
- Response caching (JS-level if needed; Rust just proxies)
- Streaming responses (not needed for these endpoints)
