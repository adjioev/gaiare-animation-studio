# GS-12: Studio — reference-image sign-fix via Gemini (crop-edit-composite)

**Phase:** 5 (sign-fix)
**Effort:** 1–1.5 day
**Depends on:** none — standalone, ships independently of GS-1..11
**Repo:** `gaiare-project/gaiare-animation-studio` (Tauri/React)

## Summary

Extend the existing **Transform** tab so it can repair a single element
(a road sign) in an image by conditioning on a reference. The motivating
case: the super-resolution pipeline (SeedVR2 + Clarity, runs in
Rails/Mastra) sharpens the overall image but **hallucinates road signs** —
invents symbols that aren't the real sign. The fix: take the enhanced
image, the *correct* sign as a reference, and a marked region, and repaint
just that region.

The editing strategy is **crop → edit → composite** (architect-confirmed,
"Option B"):

1. The user marks the sign region on the source image (drag-rectangle).
2. Studio crops that region (+ padding) in JS canvas and sends **only the
   crop** + the correct sign reference to Gemini.
3. Gemini repaints the small crop; Studio composites the result back into
   the original full image at the marked coordinates.

This is strictly better than asking Gemini to edit the whole image and
"only touch the sign": the model never sees the rest of the image, so it
**cannot mangle anything outside the region**, and placement is
deterministic because *we* paste it back, not the model. Gemini's image
API is generative, not a compositor — there is no bbox/mask parameter, so
owning the crop+composite ourselves is the only way to get precise,
collateral-free edits.

**Scope of this ticket (MVP):** the user supplies the reference as a
**URL** (SVG or raster) and marks the region with a **manual
drag-rectangle**. Auto-fetching the correct sign + region from Rails
question data is **GS-13**.

## Why Gemini, not Flux

Flux Kontext Pro (current Transform engine) takes only a single image — it
can't accept a reference. Gemini's `generateContent` supports multi-image
conditioning and this exact request shape is **already proven in Rails**
(`app/services/gemini_image_service.rb`, tutorial illustrator: prompt +
sign PNGs → rendered image).

Transform keeps **both** engines. No region marked / no reference → Flux
(current behaviour, unchanged). Reference attached + region marked →
Gemini crop-edit-composite. The tab routes by whether a reference +
region exist — **no mode toggle** (the inputs already encode intent).

> **Cost note (don't oversell):** the crop-edit approach is cheaper than
> sending the full image, but mainly on the *input* side — a small crop is
> ~3–5× fewer input tiles. Gemini's **output image is a flat per-image
> cost** regardless of size, so the net per-call saving is roughly
> **10–20%**, not multiples. The primary reason for crop-edit is
> correctness (zero collateral damage), not cost.

## Architecture (architect: proceed-with-tweaks)

### 1. Rust proxy command — `gemini_generate_image` (image-agnostic)

New `src-tauri/src/gemini.rs`, mirroring `replicate.rs` / `llm.rs`. The
command is **dumb** — it relays base64 bytes and knows nothing about
crops, signs, or bboxes. All spatial logic stays in JS.

```rust
#[tauri::command]
async fn gemini_generate_image(
    prompt: String,
    reference_images: Vec<ReferenceImage>, // { mime_type, data(base64) }
    aspect_ratio: String,                  // nearest preset to the crop's aspect
) -> Result<GeneratedImage, String>        // { mime_type, data(base64) }
```

Mirrors `GeminiImageService#generate_image`:
- POST `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- API key from env `GOOGLE_GENERATIVE_AI_API_KEY` (same source pattern as
  `REPLICATE_API_TOKEN` / `FIREWORKS_API_KEY`) — never reaches JS
- Body parts ordering = Rails `build_prompt_parts`: instruction text → ref
  images (`inlineData`) → `\n---\n\n` + prompt
- `generationConfig`: `responseModalities: ["TEXT","IMAGE"]` +
  `imageConfig: { aspectRatio }`
- Response: walk `candidates[0].content.parts[]`, return first part with
  `inlineData` → `{ mime_type, data }`
- Model is an **allowlisted constant** (mirror `ALLOWED_MODELS` from
  `replicate.rs`) defaulting to the flash image model (cheaper; user:
  "flash should be fine, we can reconfigure")

### 2. Crop → edit → composite (all JS canvas)

The whole spatial pipeline runs in the WebView, same place we rasterise
SVG → PNG. No new sidecar.

1. **Region:** user drags a rectangle over the source image →
   `bbox = { x, y, w, h }` in source-image pixel coordinates.
2. **Pad + clamp:** expand bbox by **15–20 px** on each side, clamp to
   image bounds → `paddedBbox`. The padding gives Gemini a believable
   surround to match background tone/lighting against. Store `paddedBbox`
   (it's the paste target).
3. **Crop:** `drawImage` the `paddedBbox` region into an offscreen canvas →
   the crop sent to Gemini.
4. **Aspect:** compute the crop's aspect, snap to nearest Gemini preset
   (`1:1 / 3:4 / 4:3 / 9:16 / 16:9`), pass as `aspect_ratio`. (Snap is now
   harmless — see step 6 resize.)
5. **Edit:** call `gemini_generate_image(prompt, [signRef], aspectRatio)`.
6. **Normalise size:** Gemini may return the crop at its snapped preset
   ratio, i.e. **different pixel dims than sent**. Resize the returned
   image to exactly `paddedBbox.w × paddedBbox.h` with a single
   `drawImage(result, 0, 0, paddedBbox.w, paddedBbox.h)`. Do **not** try to
   sub-rectangle the output — resize the whole returned image into the slot.
7. **Feather + composite:** apply a **4–6 px** feathered alpha blend along
   the four edges of the repainted crop, then `drawImage` it onto a copy of
   the **full original image** at `paddedBbox.x, paddedBbox.y`. Export the
   full composited canvas as PNG → the saved asset.

### 3. Region picker (`SignRegionPicker`)

New `src/components/tabs/SignRegionPicker.tsx` (~50 lines): a
drag-rectangle overlay on the source image thumbnail
(mousedown/mousemove/mouseup → rect in source-pixel coords). This is what
makes crop-edit-composite work **in MVP without Rails**. In GS-13 the same
bbox state is pre-populated from Rails data instead of drawn by hand —
zero architecture change.

### 4. Reference input (`ReferenceImagesInput`) + SVG→PNG in JS

New `src/components/tabs/ReferenceImagesInput.tsx`: URL input →
`fetch(url)` → if SVG, draw to canvas and `toBlob("image/png")`; if raster,
use bytes directly → base64 `{ mime_type, data, sourceUrl }`. Soft **JS
host-allowlist nudge** mirroring Rails `ALLOWED_SVG_HOSTS`
(`*.wikimedia.org`, Hetzner object storage) — warn-and-confirm, not a hard
block. Because the fetch is in JS (not Rust), there's no Rust-layer SSRF
surface; Rust only ever talks to `generativelanguage.googleapis.com`.

### 5. `engine` + region on Asset

Add to `src/lib/workspace.ts` Asset type, **optional, no migration**:
```ts
engine?: "flux" | "gemini";
```
The composited output is a **full-resolution image** saved as a transform
asset (`originKind: "transform"`, `engine: "gemini"`,
`parentAssetIds: [sourceId]`). Also record the `paddedBbox` in the
transform metadata so a future pass can re-apply to the same region — cheap
now, avoids a migration later.

## Acceptance criteria

- [ ] `src-tauri/src/gemini.rs` `gemini_generate_image` command registered
      in `src-tauri/src/lib.rs`; API key read in Rust only; model allowlisted
- [ ] Request body matches Rails part-ordering + `generationConfig`; response
      parsing returns first `inlineData` part
- [ ] `src/lib/gemini.ts` wrapper: `runGeminiImageEdit({ prompt, references, aspectRatio })`
- [ ] SVG and raster reference URLs both rasterise to PNG base64 in JS
- [ ] Soft host-allowlist nudge for non-trusted reference URLs
- [ ] `SignRegionPicker` drag-rectangle yields a bbox in source-pixel coords
- [ ] Crop pipeline: pad 15–20 px + clamp to bounds; crop via canvas
- [ ] Crop aspect snapped to nearest Gemini preset for the `aspect_ratio` arg
- [ ] **Returned image resized to `paddedBbox.w × paddedBbox.h`** before composite
- [ ] 4–6 px feathered edge blend; composite onto a copy of the full original
- [ ] `ReferenceImagesInput` created; TransformTab consumes picker + ref input
- [ ] Routing: reference + region present → Gemini; otherwise → Flux (unchanged)
- [ ] No mode toggle. Generate button **relabels** when in Gemini path:
      `Fix sign via Gemini`; status text distinguishes `Gemini…` vs
      `Replicate (Flux Kontext Pro)…`
- [ ] Output saved as full-res asset: `originKind:"transform"`,
      `engine:"gemini"`, `parentAssetIds:[source]`, `paddedBbox` in metadata
- [ ] `engine?: "flux" | "gemini"` added to Asset type
- [ ] Compare-with-original toggle works for the composited output

## Implementation notes

- **Rails reference (read-only):**
  `/Users/adjioev/sandbox/gaiare-project/gaiare/app/services/gemini_image_service.rb`
  — copy part-ordering + `generationConfig` exactly. Skip `svg_to_png_reference`
  (rsvg path; we use canvas).
- **Rust pattern to copy:** `replicate.rs` `request_json` + `ALLOWED_MODELS`.
- Keep `gemini_generate_image` engine-agnostic — it relays bytes only.
- Don't log the API key in any `eprintln`.
- Instruction-text part: a short fixed scaffold ("Edit the first image to
  match the reference sign. Preserve the surrounding background.") + the
  user's prompt after the `---`. Keep minimal.
- Seam will be invisible on flat backgrounds (asphalt/sky/shoulder) given
  the padding + feather; for sign-fix that's enough — correctness over
  photorealism.

## Files touched

**New:**
- `src-tauri/src/gemini.rs`
- `src/lib/gemini.ts` — wrapper + canvas SVG raster + crop/composite + host allowlist
- `src/components/tabs/ReferenceImagesInput.tsx`
- `src/components/tabs/SignRegionPicker.tsx`

**Modified:**
- `src-tauri/src/lib.rs` — register command
- `src/components/tabs/TransformTab.tsx` — picker + ref section + provider routing + relabel
- `src/lib/workspace.ts` — `engine?` on Asset + `paddedBbox` in transform metadata
- `src/components/AssetViewer.tsx` — engine badge (optional)

## Test plan

- [ ] Open Transform on an enhanced exam image with a mangled sign. Drag a
      rectangle over the sign. Paste a Wikimedia SVG of the correct sign.
      Generate → only that region repaints to the correct sign; the rest of
      the image is **byte-identical** to the source (verify with compare).
- [ ] No region/reference → Generate runs Flux Kontext Pro (regression).
- [ ] Raster reference (PNG URL) works the same as SVG.
- [ ] Crop with an odd aspect (e.g. tall narrow sign) → output still
      composites at the correct size (resize-to-slot works, no distortion
      of the rest of the image).
- [ ] Region near the image edge → padding clamps to bounds, no crash.
- [ ] Missing `GOOGLE_GENERATIVE_AI_API_KEY` → clear "Gemini not configured".
- [ ] Bad URL / 404 reference → surfaced error, Generate not fired.
- [ ] Non-trusted host URL → allowlist nudge; user can still proceed.
- [ ] Saved asset has `engine:"gemini"`, `paddedBbox`, links to source.

## Out of scope

- Auto-fetching the correct sign + region from Rails question data → **GS-13**
- Multi-region batch sign-fix across many questions
- Switching the super-resolution pipeline itself (Rails/Mastra)
- Mask/inpainting via the model (the API has none; we composite instead)
- A cost-tracking ledger (button cost hint is enough)
