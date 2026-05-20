# GS-13: Studio — auto-fetch sign references from Rails

**Phase:** 5 (sign-fix)
**Effort:** 1 day
**Depends on:** GS-12 (reference-image edit engine) + GS-2 (Rails questions
API exposes sign data) + GS-4 (Rust Rails proxy). Effectively blocked on
the whole GS-1..5 integration chain being merged.
**Repo:** `gaiare-project/gaiare-animation-studio` (Tauri/React) — plus a
small read from the Rails Studio API

## Summary

Remove the **manual steps** from GS-12 — both the pasted reference URL and
the hand-drawn region. When a question is opened from Rails
(browse-and-open, GS-5), Studio **already knows** which signs belong to the
question, their canonical SVG/PNG, and **where they are** — that data lives
in Rails (`question.signs`, `visual_context_json.signs[]` with codes and
**bbox**, and the sign SVG/PNG assets). This ticket auto-populates GS-12's
inputs from that data: the reference image **and** the crop region come
from Rails, so the user clicks one button instead of pasting a URL and
dragging a rectangle by hand.

GS-12 proves the full crop-edit-composite render path with a pasted URL +
manual drag-rectangle. GS-13 wires the *source* of both — reference and
bbox — to Rails. **The render pipeline is unchanged**; this ticket only
adds a data source.

## Why this is a separate ticket

GS-12 ships value **today** with zero Rails dependency. GS-13 needs:
- the Rails Studio API (GS-2) to expose per-question sign codes + their
  canonical SVG/PNG URLs (and ideally bbox from `visual_context_json`)
- the Rust Rails proxy (GS-4) + browse-and-open (GS-5) so a question's
  context is loaded in the workspace at all

Bundling them would block the useful MVP behind the entire integration
roadmap. Architect: split.

## What Rails already has (to confirm during impl)

- `question.signs` — the correct sign codes for the question (the
  authoritative set the answer depends on)
- `visual_context_json.signs[]` — detected signs with codes, and possibly
  position hints
- Sign SVGs are sourced from WikiMedia / object storage (same hosts as the
  GS-12 allowlist) and rasterised in Rails via `rsvg-convert` for the
  tutorial illustrator — so canonical URLs per sign code exist

**Open question for GS-2 scope:** does the Studio questions endpoint
return sign code → SVG URL mappings and bbox, or does Studio resolve the
SVG URL from the code itself? Decide when GS-2 is specced; this ticket
consumes whatever GS-2 exposes.

## Acceptance criteria

- [ ] When a Rails-opened question is the Transform source, a
      **"Load signs from question"** action appears in `ReferenceImagesInput`
- [ ] It fetches the question's correct sign(s) + canonical SVG/PNG URL(s)
      via the Rust Rails proxy (GS-4), reusing GS-12's canvas rasterise
- [ ] Each loaded sign becomes a reference entry (thumbnail + code label +
      remove), pre-filling the list GS-12 built
- [ ] If `visual_context_json.signs[].bbox` is present, the crop region is
      **populated programmatically** — the same `paddedBbox` that GS-12's
      drag-rectangle produces, fed straight into the crop-edit-composite
      pipeline. The user does not draw the rectangle.
- [ ] Bbox coordinate format (image-relative pixels vs normalised 0–1
      floats) is confirmed against what GS-2 exposes and documented here;
      the picker converts to source-pixel coords before cropping
- [ ] When a sign has a reference but **no bbox** in Rails data, fall back
      to GS-12's manual drag-rectangle (and, last resort, a natural-language
      location hint in the prompt)
- [ ] Falls back gracefully to GS-12's fully-manual path when the source
      image is **not** a Rails question (local asset) or has no sign data
- [ ] No regression to GS-12's manual path
- [ ] Sign URLs resolved this way skip the host-allowlist nudge (they come
      from Rails-trusted hosts by construction)

## Implementation notes

- Reuse everything from GS-12: the Rust `gemini_generate_image` command,
  the canvas rasteriser, the crop-edit-composite pipeline, the
  `ReferenceImagesInput` + `SignRegionPicker` components. This ticket adds a
  **data source**, not a new render path.
- The "which question is the source" link comes from the asset's Rails
  origin metadata established in GS-5 (browse-and-open). If that metadata
  isn't on the asset yet, extend the asset/origin model as part of GS-5,
  not here.
- Bbox feeds the pipeline as **coordinates**, not a natural-language hint —
  GS-12 already owns the crop+composite, so we hand it the same `paddedBbox`
  the drag-rectangle would have produced. Confirm the coordinate format
  (pixels vs normalised) when GS-2 is specced and convert to source-pixel
  coords before cropping. Natural-language phrasing is a last-resort
  fallback only (no bbox AND no manual rectangle).

## Files touched

**Modified:**
- `src/components/tabs/ReferenceImagesInput.tsx` — "Load signs from question" source
- `src/lib/rails.ts` — sign-fetch wrapper (or extend `getQuestion` from GS-4)
- `src/components/tabs/TransformTab.tsx` — pass Rails origin context down +
  auto-populate the crop region from bbox
- possibly `src-tauri/src/rails.rs` — if a dedicated sign-fetch endpoint is
  cleaner than reusing `rails_get_question`

## Test plan

- [ ] Open a Rails question with a known mangled sign via browse-and-open
      → Transform → "Load signs from question" → correct sign appears as a
      reference with its code, crop region auto-populated from bbox →
      Generate fixes the sign.
- [ ] Question with multiple signs → all load as references.
- [ ] Local (non-Rails) asset → "Load signs from question" hidden/disabled,
      manual URL input still available (GS-12 fallback).
- [ ] Question with no sign data → graceful empty state, manual fallback.

## Out of scope

- Batch sign-fix across many questions in one run (per-question for now)
- Re-running the Rails super-resolution pipeline from Studio
- Writing the fixed image back to Rails — that's the publish flow (GS-8)
- An advanced region editor (polygon/mask, multi-region per sign) — GS-12's
  rectangle + Rails bbox cover the need at this scale
- Adjusting/nudging the auto-populated bbox by hand before Generate (can
  fall back to GS-12's drag-rectangle if the Rails bbox is off)
