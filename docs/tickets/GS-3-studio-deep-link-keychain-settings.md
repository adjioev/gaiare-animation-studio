# GS-3: Studio — deep-link, OS keychain, Connect-to-Rails Settings

**Phase:** 1
**Effort:** 1 day
**Depends on:** GS-1 (Rails auth endpoints live)
**Repo:** `gaiare-project/gaiare-animation-studio` (Tauri/React)

## Summary

Studio-side magic-link flow: register `gaiare-studio://` custom URL scheme,
add "Connect to Rails" button to Settings modal, exchange auth code for
long-lived token, store token in OS keychain (not localStorage). After
this ticket, the Studio app holds a working Rails bearer token and can
make authenticated API calls.

## Acceptance criteria

- [ ] `tauri.conf.json` `plugins.deep-link` configured with scheme
      `gaiare-studio`. Tauri 2 ships `@tauri-apps/plugin-deep-link` as
      first-party. Bundle identifier-scoped.
- [ ] `tauri-plugin-keystore` (or `keyring-rs` crate via custom command)
      wired for OS keychain access. On macOS this is the system Keychain.
- [ ] `Settings` schema gains `railsServer?: { url: string, userEmail?: string }`.
      Token is NEVER stored in `Settings` — it lives in keychain only.
- [ ] `SettingsModal` gains a "Rails connection" section:
  - If no `railsServer` set: input for server URL (default
    `http://localhost:3011`) + "Connect" button.
  - If connected: shows `userEmail`, `Server: <url>`, "Disconnect" button.
  - "Connect" click → opens flow described below.
- [ ] Connect flow:
  1. Generate random `state` (`crypto.randomUUID()`)
  2. `POST <server>/studio/auth/initiate` with `{ state }` (no auth yet)
  3. Server returns `{ authorize_url }`
  4. Studio opens authorize_url in system browser via
     `@tauri-apps/plugin-opener` `openUrl()`
  5. Studio waits for deep-link callback (`gaiare-studio://auth?code=...&state=...`)
  6. On callback: verify `state` matches what we sent
  7. `POST <server>/studio/auth/exchange` with `{ code, state }`
  8. Receive `{ token, user: { email } }`. Store token in keychain
     under key `gaiare-studio.rails-token.<server-hash>`. Store
     `{ url, userEmail }` in Settings (non-secret).
  9. Show success state in SettingsModal
- [ ] Cancel paths handled:
  - User closes browser without approving → timeout after 5 min, reset UI
  - Wrong state on callback → error toast "Auth callback didn't match —
    try again"
  - Exchange returns 410 / 400 → error toast with reason
- [ ] Disconnect: removes token from keychain, clears `Settings.railsServer`
- [ ] `getRailsToken()` helper in `src/lib/rails.ts` exports the token for
      other modules; returns `null` if not connected. Single function for
      all callers.
- [ ] App start: if `Settings.railsServer` exists but keychain has no
      token, show a banner: "Rails connection lost — reconnect via
      Settings". Don't crash.

## Implementation notes

- **Plugin dependencies** in `package.json`:
  - `@tauri-apps/plugin-deep-link`
  - `@tauri-apps/plugin-opener` (already installed)
  - Optional: `@tauri-apps/plugin-keystore` (newer Tauri version may need
    `tauri-plugin-stronghold` instead — verify Tauri 2 ecosystem)
- **Rust crate** in `src-tauri/Cargo.toml`: `tauri-plugin-deep-link`,
  `keyring = "3"` (or the Tauri-native equivalent). Architect noted
  Stronghold is non-trivial; `keyring` is the right trade-off.
- **macOS Info.plist via `tauri.conf.json`** — add `CFBundleURLTypes` so
  macOS knows our scheme. Tauri 2's deep-link plugin handles this
  configuration declaratively.
- **Deep-link listener** in Rust `lib.rs`:
  ```rust
  app.deep_link().on_open_url(|event| {
      let url = event.urls().first().cloned();
      // Forward to JS via emit
      app.emit("deep-link-callback", url).ok();
  });
  ```
- **JS-side listener**: `listen("deep-link-callback", handler)` set up
  while the connect modal is open. Cleanup on unmount.
- **Token never in localStorage**: even temporarily. Pass directly from
  exchange response to keychain `set`. Read-on-demand via
  `getRailsToken()` (cached in-memory for the session).
- **Server-hash key**: `gaiare-studio.rails-token.${sha256(serverUrl).slice(0,8)}`
  — supports having different tokens per server (local vs prod) without
  collision.

## Files touched

**New:**
- `src/lib/rails.ts` — `connect()`, `disconnect()`, `getRailsToken()`,
  `getRailsServerUrl()` helpers
- `src-tauri/src/rails_auth.rs` — Rust commands for keychain set/get/delete
  + deep-link receiver
- Migration step: add `tauri-plugin-deep-link` + `keyring` crate deps

**Modified:**
- `src-tauri/Cargo.toml`
- `src-tauri/src/lib.rs` — register plugin + handlers
- `src-tauri/tauri.conf.json` — deep-link scheme config
- `src-tauri/capabilities/default.json` — allow deep-link, keystore,
  opener permissions
- `src/components/SettingsModal.tsx` — "Rails connection" section
- `src/lib/settings.ts` — add `railsServer` field
- `package.json` — new TS deps

## Test plan

- [ ] Run Studio + Rails locally. Open Settings → "Rails connection" →
      type `http://localhost:3011` → click Connect
- [ ] Browser opens; sign in if needed; click Approve
- [ ] Browser navigates to `gaiare-studio://auth?code=...&state=...`
- [ ] macOS shows "Open in Animation Studio?" prompt (or auto-routes if
      app was first-launched after install) — confirm app receives the
      URL
- [ ] Settings now shows `Connected as <email> at http://localhost:3011`
- [ ] Quit + relaunch Studio → still connected (token survives in keychain)
- [ ] Click Disconnect → token removed from keychain; Settings shows
      Connect button again
- [ ] Open Keychain Access on macOS → search for `gaiare-studio` → entry
      exists when connected, gone after disconnect
- [ ] Reset state midway (close browser before approving) → after 5 min
      Studio shows "Auth timed out" + Connect button reappears
- [ ] Modify Rails to return 401 on `/studio/auth/exchange` → Studio
      surfaces the error rather than silently failing

## Out of scope

- Windows / Linux deep-link parity (macOS-only is fine for Phase 1)
- Token rotation / refresh (single long-lived token; revoke via Rails
  Avo if needed — handled by GS-1)
- Multiple Rails server connections simultaneously (one active at a
  time; switching disconnects current)
