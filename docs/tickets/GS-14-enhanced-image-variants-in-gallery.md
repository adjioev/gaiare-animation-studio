# GS-14: Enhanced image variants in the workspace gallery (locked)

**Phase:** 5 (enhance / sign-fix family)
**Effort:** ~1 day
**Depends on:** GS-2 (questions API), GS-5 (browse-and-open flow) — both merged
**Repo:** `gaiare-project/gaiare` (Rails) + `gaiare-project/gaiare-animation-studio` (Studio)

## Summary

A question can have up to three image variants on Hetzner, addressed purely
by path convention (there is **no DB flag** — existence = file present):

| Variant | Path | Notes |
|---|---|---|
| original | `…/images/<name>` | the literal exam image (`Question#image_url`) |
| enhanced | `…/images/enhanced/<name>` | SeedVR2 + Gemini + Clarity (`Question#enhanced_image_url`) |
| enhanced-safe | `…/images/enhanced-safe/<name>` | SeedVR2 only — signs less mangled (`Question#safe_image_url`) |

Today, opening a question pulls only the original as the workspace
**source**. Contractors usually want to animate/edit from the **enhanced**
image (higher quality), and **enhanced-safe** is the natural input for the
sign-fix flow (GS-12). This ticket brings the available variants into the
gallery as **locked** assets so they can be picked as Generate/Transform
inputs and can't be deleted by accident.

## Why locked

The variants are canonical, Rails-sourced source-of-truth images — not
throwaway derivatives the contractor produced. Deleting one loses a good
input. They get the same protection as the `source` asset.

## Design decisions (agreed)

1. **No existence flag exists** — detection is "try to fetch, skip on
   404". Do it in Studio at **open time** (not during browse — a 20-row
   list must not fire 40 HEAD requests).
2. **Rails owns the path scheme**, not Studio. The API returns candidate
   URLs via the existing model methods; Studio never builds
   `/images/enhanced/...` itself.
3. **`original` stays the `source`** (protected anchor, the exam frame).
   `enhanced` / `enhanced_safe` are additional locked image assets.

## Part A — Rails (GS-2 extension)

- [ ] `Api::V1::Studio::QuestionsController#question_json` adds an
      `images` object built from the model methods:
      ```json
      "images": {
        "original": "https://…/images/q.png",
        "enhanced": "https://…/images/enhanced/q.png",
        "enhanced_safe": "https://…/images/enhanced-safe/q.png"
      }
      ```
      Values come from `image_url` / `enhanced_image_url` / `safe_image_url`.
      These are **candidate** URLs (may 404 — that's expected; no existence
      check server-side). Omit a key when the model method returns nil
      (e.g. `image_url` blank).
- [ ] Keep the existing top-level `image_url` for backwards compatibility
      (GS-5 still reads it).
- [ ] Test: `images` present with the three derived URLs for a question
      whose `image_url` includes `/images/`.

## Part B — Studio

### Asset model (`src/lib/workspace.ts`)

- [ ] Generalise protection beyond the single `source` role. Options
      (pick during impl): broaden `role` to
      `"source" | "enhanced" | "enhanced_safe"` and treat **any** set
      role as "locked", OR add an explicit `locked?: boolean`. `source`
      retains its special meaning (default anchor, the exam frame).
- [ ] Add `remoteUrl?: string` to `Asset` so a locked variant can be
      re-fetched if its file goes missing on load — the same recovery the
      `source` asset gets today via `workspace.sourceUrl`. (Source can
      keep using `sourceUrl`, or migrate to `remoteUrl` for uniformity.)
- [ ] Backfill on load: legacy assets have no role/remoteUrl — unaffected.

### Open flow (`OpenQuestionModal` → `App.createWorkspaceFromModal`)

- [ ] On open, after the original is set as `source`, attempt to fetch
      `images.enhanced` and `images.enhanced_safe`:
  - HTTP 200 → save the bytes as a locked image asset
    (`role: "enhanced"` / `"enhanced_safe"`, `remoteUrl` set,
    `originKind` accordingly). The fetched bytes are reused — no second
    request.
  - 404 / fetch error → skip silently (variant doesn't exist).
- [ ] Don't block opening on the variants — original is enough; variants
      are best-effort.

### Deletion guard + viewer

- [ ] The gallery delete path refuses to delete any locked asset (today
      it blocks `role === "source"` — extend to the locked set).
- [ ] `AssetViewer` shows the 🔒 protected badge + "can't delete" copy for
      all locked variants, with a label distinguishing original / enhanced
      / enhanced-safe.

### Re-fetch on load

- [ ] On workspace load, a locked asset whose file is missing re-downloads
      from its `remoteUrl` (mirror the existing `ensureSourceAsset`
      recovery; generalise it to all locked assets).

### Optional

- [ ] Default the seed Generate tab's input to `enhanced_safe` when
      present (falls back to `source`). Decide during impl — may be
      surprising; keep behind a simple "best available" helper.

## Files touched

**Rails:**
- `app/controllers/api/v1/studio/questions_controller.rb` (+ test)

**Studio:**
- `src/lib/rails.ts` — `StudioQuestion.images?: { original?, enhanced?, enhanced_safe? }`
- `src/lib/workspace.ts` — Asset role set / `locked` + `remoteUrl`; generalise protection + backfill
- `src/App.tsx` — `createWorkspaceFromModal` fetches + adds locked variants; generalise `ensureSourceAsset` re-fetch + delete guard
- `src/components/AssetViewer.tsx` — locked badge/labels for variants

## Test plan

- [ ] Open a question that HAS enhanced + enhanced-safe → gallery shows 3
      images (original=source, enhanced, enhanced-safe), all 🔒.
- [ ] Open a question with NO enhanced variants → only the original, no
      errors, no console 404 noise beyond the skipped fetches.
- [ ] Try to delete an enhanced asset → blocked (same as source).
- [ ] Delete the enhanced file on disk, reload workspace → it re-downloads
      from `remoteUrl`.
- [ ] Pick `enhanced-safe` as a Transform input → sign-fix flow works on it.

## Out of scope

- A real existence flag / index on Question (none exists; 404-skip is the
  contract). If batch existence ever matters, that's a separate Rails change.
- Auto-running the enhance pipeline from Studio (lives in Rails/Mastra).
- Publishing the chosen variant back to Rails (Phase 2 / content git).
