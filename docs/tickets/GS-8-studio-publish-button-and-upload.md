# GS-8: Studio — Publish button + signed-URL upload

**Phase:** 2
**Effort:** 1 day
**Depends on:** GS-6 + GS-7 (Rails publish + presigner live), GS-4 (Rails proxy)
**Repo:** `gaiare-project/gaiare-animation-studio` (Tauri/React)

## Summary

Wire the Studio AssetViewer's "Publish to question" action. Workflow:
fetch signed PUT URL from Rails → upload mp4 bytes directly to Hetzner →
PATCH Rails with object_key + metadata. Track per-asset publish state in
workspace.json so the gallery shows "✓ published" / "↻ republish".

## Acceptance criteria

- [ ] `Asset` type gains optional fields (workspace.json v3 — coordinate
      with GS-9 OR add now if GS-9 lands later):
  - `publishedAt?: string` (ISO timestamp)
  - `publishedUrl?: string` (Hetzner public URL of the published clip)
  - `publishedAsQuestion?: string` (composite `<country>/<ref>` so we
    know which question this clip became)
- [ ] `Workspace` type gains `linkedQuestion?: { external_ref, country_code, id }`
      so we know which Rails question this workspace is for. Populated
      by GS-5's browse-and-open flow. Manual-entry workspaces leave it
      null and can't publish (button disabled with tooltip).
- [ ] AssetViewer footer adds a third button:
  - Primary order (right-to-left): "Publish to question" (new) ·
    "Use as input" · "Open in new tab" · "Close"
  - Visible only for `kind === "video"` assets
  - Disabled if `!workspace.linkedQuestion`, tooltip "Open this
    workspace from Rails to enable publishing"
  - Disabled if `!getRailsToken()`, tooltip "Connect to Rails in
    Settings to publish"
  - Labelled "Republish" if `asset.publishedAt` is set; styled with
    amber warning hint
- [ ] Click flow:
  1. Confirm modal: "Publish clip to Q<external_ref>?" — explicit, lists
     what will happen (uploads to Hetzner, updates Rails question's
     `answer_video_url`, plays after user answers). If republish:
     warning "This replaces the current animation."
  2. Status pill: "requesting signed URL…"
  3. Rust command `rails_request_upload_url(question_id, content_type)` →
     returns `{ upload_url, object_key, headers }`
  4. Status pill: "uploading <size> MB…"
  5. Rust command `hetzner_put_file(local_path, upload_url, headers)` —
     PUTs the asset file's bytes
  6. Status pill: "finalising…"
  7. Rust command `rails_finalise_animation(question_id, { object_key,
     duration_sec, prompt, ... })` → returns updated Question JSON
  8. Update asset in workspace: set `publishedAt`, `publishedUrl`,
     `publishedAsQuestion`
  9. Update workspace's `linkedQuestion.answer_video_url` (cached for
     republish indicator)
  10. Close modal, show toast "Published as Q<ref> animation"
- [ ] Failure handling at each step shows the actual error (matches
      existing `errorMessage()` helper):
  - Upload fails midway → retry button in toast
  - Rails 401 → "Reconnect to Rails" CTA
  - Hetzner 5xx → "Hetzner unavailable, try again"
  - HEAD-check failure on finalise → automatic retry of upload + finalise
    once (Hetzner consistency window can briefly miss the object)
- [ ] Gallery: video assets with `publishedAt` show a small `✓` badge
      near the duration. Tooltip shows the published URL + when.
- [ ] Re-publishing the SAME asset (re-saving + re-clicking publish) —
      `publishedAt` updates to new time; URL stays the same (same
      object_key for the question).

## Implementation notes

- New Rust commands in `src-tauri/src/rails.rs` (extends GS-4):
  - `rails_request_upload_url(question_id: String, content_type: String) -> Value`
  - `rails_finalise_animation(question_id: String, body: Value) -> Value`
  - `hetzner_put_file(abs_path: String, upload_url: String, headers: Map<String,String>)`
- `hetzner_put_file` uses `reqwest::Client::put(upload_url).headers(...).body(stream-from-file)`.
  Streaming the file (not loading into Vec<u8>) — important for 50-100MB
  videos.
- Path safety: same `assert_safe_document_path` check as `replicate_upload_file`
  ensures the abs_path is under Documents.
- URL safety: `upload_url` host must match `HETZNER_HOST` (validated in
  Rust). Reject anything else — token bleed to attacker host even though
  no token is in headers here, the bytes themselves leak.
- Studio side TS wrapper: `publishAsset(asset, question, metadata)` —
  encapsulates the 3-step flow, handles status callbacks for the UI.

## Files touched

**New:**
- Helpers in `src/lib/rails.ts` for the 3 commands
- No new components — modify AssetViewer + AssetGallery + workspace
  schema

**Modified:**
- `src-tauri/src/rails.rs` — three new commands
- `src-tauri/src/lib.rs` — register them
- `src/lib/workspace.ts`:
  - Asset: add `publishedAt?`, `publishedUrl?`, `publishedAsQuestion?`
  - Workspace: add `linkedQuestion?`
- `src/App.tsx` — pass `linkedQuestion` + `onPublish` to AssetViewer
- `src/components/AssetViewer.tsx` — new button + flow
- `src/components/AssetGallery.tsx` — `✓` badge on published video
  cards

## Test plan

- [ ] Open workspace from Rails browse modal (GS-5) — Q14 in Georgia
- [ ] Generate a clip → it appears in gallery
- [ ] Open it in AssetViewer → "Publish to question" button visible,
      enabled
- [ ] Click → confirm → upload starts (status pill updates) → finalises
- [ ] Verify on Rails (Avo or DB): Q14.answer_video_url is set to the
      Hetzner URL; last_published_at is now
- [ ] Open the Hetzner URL in browser → mp4 plays
- [ ] In Studio gallery, the clip now shows `✓` badge with publish time
- [ ] Click "Republish" on same asset → warning modal → completes →
      Rails timestamp updates, URL unchanged
- [ ] Manual-entry workspace (typed external_ref, not from Rails) →
      Publish button disabled with helpful tooltip
- [ ] Disconnect Rails → Publish button shows "Connect to Rails" hint
- [ ] Network interruption mid-upload → error pill + retry option
- [ ] Tampered upload_url (e.g. localhost) → Rust rejects before bytes
      sent

## Out of scope

- Source image upload (only `answer_video_url` for now)
- Progress bar with bytes transferred (status pill text is enough)
- Batch publish (one asset at a time)
- Webhook / push notification to gaiare-next-server (it just refreshes
  from Rails)
- Unpublish / remove `answer_video_url` (manual via Avo for now)
