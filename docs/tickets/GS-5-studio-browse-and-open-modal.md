# GS-5: Studio — browse-and-open modal replaces "New Workspace"

**Phase:** 1
**Effort:** 0.5 day
**Depends on:** GS-4 (Rails proxy commands work)
**Repo:** `gaiare-project/gaiare-animation-studio` (Tauri/React)

## Summary

Replace the manual "type external_ref + paste URL" NewWorkspaceModal with
a richer modal that lists actual questions from Rails. Filters by
cognitive_type, country, animation status. Click → workspace auto-creates
with the question's image as source. Manual entry stays as a fallback
for unconnected sessions.

## Acceptance criteria

- [ ] `OpenQuestionModal` component (new) — full-screen overlay with:
  - **Header**: "Open question" title, server connection indicator
    (`Connected to: <url> · <email>`), close ×
  - **Filter row**:
    - Country dropdown (from `listCountries()`, defaults from Settings)
    - Cognitive type dropdown (textual / situational / procedural /
      signquiz / medical — values from Rails enum)
    - Animation status: "All" / "Needs animation" / "Has animation"
    - Search input (debounced, 300 ms)
  - **Results list** (paginated, vertical scroll):
    - Each row: thumbnail (from `image_url`), `Q<external_ref>`, text
      excerpt (first 80 chars), cognitive_type badge, status badge
      ("⏳ no animation" / "✅ animation")
    - Click → triggers open flow (below)
    - Pagination buttons or infinite-scroll loader
  - **Empty state**: "No questions match your filters" with suggestion
  - **Loading state**: skeleton rows
  - **Error state**: if Rails returns `rails_auth_expired`, show "Reconnect
    to Rails" CTA that opens SettingsModal
- [ ] Click question → open flow:
  1. Show busy overlay "Opening Q<ref>…"
  2. Fetch full details if needed (for fields not in list response)
  3. Create workspace: `externalRef`, `country` (from question's
     `country_code`), `sourceUrl` (from `image_url`)
  4. `ensureSourceAsset` downloads the image into the workspace dir
     (existing flow)
  5. Close modal, activate the new workspace
- [ ] Existing "New workspace" entry point opens this new modal (replace
      `setNewWorkspaceOpen(true)` → `setOpenQuestionOpen(true)`)
- [ ] **Fallback for unconnected sessions**: if `getRailsToken()` returns
      null, the modal shows a "Manual entry" sub-form (the old
      NewWorkspaceModal inputs: external_ref + URL) + a "Connect to
      Rails" CTA. NewWorkspaceModal component can stay or be merged into
      this one — pick simpler.
- [ ] Re-opening Q14 when a workspace `georgia/q14` already exists:
      switches to that workspace instead of clobbering. (Reuse logic
      from existing workspace-switching flow.)
- [ ] Esc to close, click backdrop to close
- [ ] All filter state persists in component-local React state (not
      URL, not Settings) — but defaults pull from Settings
      (`defaultCountry`, `defaultCognitiveType`)

## Implementation notes

- Modal styling: match existing `ConfirmModal` / `NewWorkspaceModal`
  chrome — `<div className="fixed inset-0 ... bg-black/70 ...">`.
- Result list: `w-full max-w-4xl` modal width, the list area
  `max-h-[60vh] overflow-y-auto`. Cards use grid or flex.
- Thumbnails: `<img src={image_url} loading="lazy" />` — Hetzner URLs
  are public so plain `<img>` works (no need for Tauri's `convertFileSrc`).
- Filter changes debounce: 300 ms for search, instant for dropdowns.
- Pagination: simple "Previous / Next" + "Page X of Y" for MVP. Infinite
  scroll is a follow-up.
- The workspace creation reuses `createWorkspaceFromModal` from App.tsx
  (existing) — just pass the right `externalRef` + `sourceUrl` shape.
- Pre-fill the country in Settings if user picks a question from a
  country they haven't worked on yet — gently update `defaultCountry`.

## Files touched

**New:**
- `src/components/OpenQuestionModal.tsx`

**Modified:**
- `src/App.tsx`:
  - Replace `setNewWorkspaceOpen` state with `setOpenQuestionOpen`
  - Pass `createWorkspaceFromQuestion` callback (new — takes
    `{ external_ref, country_code, image_url }` and builds workspace)
- `src/lib/settings.ts` — add `defaultCountry?: string`
- Optional: delete `NewWorkspaceModal.tsx` if fully replaced, or keep
  as nested fallback

## Test plan

- [ ] Studio connected to Rails. Click "+ New" → OpenQuestionModal opens
- [ ] Default filter: country = Settings.defaultCountry, all cognitive
      types, "Needs animation"
- [ ] Change cognitive_type to "procedural" → list updates, only
      procedural Q's shown
- [ ] Search "intersection" → debounce 300ms → matching results
- [ ] Click Q14 → busy state → source image downloads → workspace `georgia/q14`
      opens with the image as source
- [ ] Open Q14 again from the modal → switches to existing workspace
      (no duplicate)
- [ ] Disconnect from Rails. Click "+ New" → modal shows manual entry
      form + "Connect to Rails" link
- [ ] Empty results state when filters return nothing
- [ ] Rails returns 401 mid-session (revoke token) → "Reconnect" CTA appears

## Out of scope

- Search-as-you-type with full-text relevance ranking (basic ILIKE is
  fine)
- Filtering by topic / subtopic / signage type (not needed for MVP;
  cognitive_type is the primary axis user mentioned)
- Bulk select / open multiple questions (single-question workflow)
- Real-time list updates (manual filter re-trigger refreshes)
