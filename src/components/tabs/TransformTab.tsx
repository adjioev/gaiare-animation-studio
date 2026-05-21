// Transform-image tab — applies a natural-language edit to an image
// asset via Flux Kontext Pro on Replicate ("remove yellow arrows",
// "make sky cloudy"). Result auto-saves as a new image asset with
// `originKind: "transform"` and the source as its parent — the cleaned
// version can then become the input to a Generate tab without ever
// touching the protected source.
//
// Pedagogical note for the UI: when a user removes the exam's yellow
// arrows from the start frame, the generated animation no longer
// "matches" the still image the student saw on the exam. Memory anchor
// is broken. We surface a small warning so the contractor makes that
// trade-off knowingly.

import { useEffect, useRef, useState } from "react";
import {
  FLUX_KONTEXT_COST_USD,
  runClarity,
  runFluxKontext,
  runSeedVR2,
  uploadFileToReplicate,
  type Prediction,
} from "../../lib/replicate";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { BaseDirectory, mkdir, readFile, writeFile } from "@tauri-apps/plugin-fs";
import {
  absPath,
  asset,
  downloadInto,
  ensureWorkdir,
  qdir,
} from "../../lib/workdir";
import {
  Button,
  StatusPill,
  Textarea,
  errorMessage,
  shorten,
  type StatusState,
} from "../ui";
import {
  generateAssetFilename,
  newAssetId,
  relPathForAsset,
  type Asset,
} from "../../lib/workspace";
import { ImageLightbox } from "../ImageLightbox";
import { SignFixList, fixColor, type SignFix } from "./SignFixList";
import {
  SignRegionPicker,
  type PickerRegion,
  type Rect,
} from "./SignRegionPicker";
import {
  base64ToBytes,
  fetchReferenceInline,
  loadImageFromBase64,
  runGeminiCropEdit,
} from "../../lib/gemini";

type Status = { state: StatusState; message?: string };

/** Gemini accepts only these output aspect presets. We snap the source
 *  image's aspect to the nearest one so the corrected photo keeps roughly
 *  the same shape (user asked for "match input aspect"). */
const ASPECT_PRESETS: Array<{ label: string; ratio: number }> = [
  { label: "9:16", ratio: 9 / 16 },
  { label: "3:4", ratio: 3 / 4 },
  { label: "1:1", ratio: 1 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "16:9", ratio: 16 / 9 },
];

function nearestPreset(ratio: number): { label: string; ratio: number } {
  let best = ASPECT_PRESETS[0];
  for (const p of ASPECT_PRESETS) {
    if (Math.abs(p.ratio - ratio) < Math.abs(best.ratio - ratio)) best = p;
  }
  return best;
}

export function TransformTab({
  folderName,
  externalRef,
  inputAsset,
  inputAssetPublicUrl,
  inputAssetThumbUrl,
  prompt,
  onPromptChange,
  onSave,
  onOpenLibrary,
  questionSigns = [],
}: {
  folderName: string;
  externalRef: string;
  inputAsset: Asset | null;
  /** When the input is the source image, the workspace's public CDN
   *  URL works as Flux Kontext's `input_image`. Other image assets
   *  (extracted frames, prior transforms) get uploaded to Replicate
   *  Files API on demand. */
  inputAssetPublicUrl: string | null;
  inputAssetThumbUrl: string | null;
  prompt: string;
  onPromptChange: (next: string) => void;
  onSave: (asset: Asset) => Promise<void>;
  /** Open the prompt library (flux edit prompts). */
  onOpenLibrary: (mode: "browse" | "save") => void;
  /** Correct signs from Rails — powers "Load signs from question" in the
   *  sign-fix list (each becomes a fix with its SVG as the reference). */
  questionSigns?: { code: string; name: string | null; svgUrl: string }[];
}) {
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [latestUrl, setLatestUrl] = useState<string | null>(null);
  // Image-operation mode: "edit" (Flux edit + Gemini sign-fix) or "enhance"
  // (SeedVR2 upscale + Clarity polish). Enhance has no parameters, so it
  // lives here as a mode rather than its own tab.
  const [mode, setMode] = useState<"edit" | "enhance">("edit");
  const abortRef = useRef<AbortController | null>(null);

  // Sign-fix state. Each fix pairs one marked region with one reference
  // sign; kept local (not persisted to workspace.json) for now. A fix is
  // "complete" once it has both a region and a reference.
  const [fixes, setFixes] = useState<SignFix[]>([]);
  const [activeFixId, setActiveFixId] = useState<string | null>(null);
  // Full-screen zoom for inspecting sign details.
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const completeFixes = fixes.filter((f) => f.referenceUrl && f.region);
  // At least one complete fix → route Generate to the Gemini crop-edit
  // path instead of Flux.
  const signFixMode = completeFixes.length > 0;

  useEffect(() => {
    setLatestUrl(null);
    setStatus({ state: "idle" });
    setFixes([]);
    setActiveFixId(null);
    setLightboxSrc(null);
  }, [inputAsset?.id]);

  function setActiveRegion(rect: Rect | null) {
    if (!activeFixId) return;
    setFixes((prev) =>
      prev.map((f) => (f.id === activeFixId ? { ...f, region: rect } : f)),
    );
  }

  // Append a fix row per Rails sign (reference = its SVG), skipping signs
  // whose reference is already in the list. Region stays null — the user
  // marks where each sign is (no bbox from Rails yet).
  function loadSignsFromQuestion() {
    setFixes((prev) => {
      const present = new Set(prev.map((f) => f.referenceUrl));
      const added = questionSigns
        .filter((s) => !present.has(s.svgUrl))
        .map((s) => ({
          id: crypto.randomUUID(),
          referenceUrl: s.svgUrl,
          region: null,
        }));
      return [...prev, ...added];
    });
  }

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  async function generate() {
    if (!inputAsset) {
      setStatus({
        state: "error",
        message: "Pick an image from the gallery first.",
      });
      return;
    }
    if (!prompt.trim()) {
      setStatus({
        state: "error",
        message: "Describe the edit you want (e.g. 'remove yellow arrows').",
      });
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLatestUrl(null);
    try {
      // Resolve image URL — source images already have a public CDN
      // URL; other image assets get uploaded to Replicate's Files API.
      let imageUrl: string;
      if (inputAssetPublicUrl) {
        imageUrl = inputAssetPublicUrl;
      } else {
        setStatus({ state: "running", message: "uploading frame…" });
        const localAbs = await absPath(
          relPathForAsset(folderName, externalRef, inputAsset),
        );
        imageUrl = await uploadFileToReplicate(localAbs);
        if (controller.signal.aborted) return;
      }

      setStatus({
        state: "running",
        message: "Replicate (Flux Kontext Pro)…",
      });
      const resultUrl = await runFluxKontext(
        { input_image: imageUrl, prompt },
        {
          signal: controller.signal,
          onTick: (p: Prediction<string>) =>
            setStatus({
              state: "running",
              message: `replicate ${p.status}…`,
            }),
        },
      );
      if (controller.signal.aborted) return;

      setStatus({ state: "running", message: "downloading…" });
      await ensureWorkdir(folderName, externalRef);

      const newId = newAssetId();
      // Flux Kontext outputs PNG (the model rejects webp; png is
      // lossless — no artifacts in the patched region). The `.png`
      // extension keeps downstream mime-detection honest (`guessMime`
      // in ChatPanel, `guess_content_type` in the Rust upload command)
      // when this asset is later re-sent to Replicate as a Wan input.
      const filename = generateAssetFilename({
        id: newId,
        kind: "image",
        hint: "frame",
        ext: "png",
      });
      const rel = await downloadInto({
        folderName,
        externalRef,
        filename,
        url: resultUrl,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      const newAsset: Asset = {
        id: newId,
        kind: "image",
        originKind: "transform",
        filename,
        label: `Edit: ${shorten(prompt.trim(), 48)}`,
        prompt,
        parentAssetIds: [inputAsset.id],
        createdAt: Date.now(),
      };
      await onSave(newAsset);
      setLatestUrl(await asset(rel));
      setStatus({ state: "done", message: "saved to gallery" });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setStatus({ state: "idle" });
        return;
      }
      setStatus({ state: "error", message: errorMessage(e) });
    }
  }

  // Gemini sign-fix, region-scoped (crop → edit → composite). For each
  // complete fix we crop just that sign's region (+ a small margin) from
  // a running full-image canvas, send ONLY that crop + its reference to
  // Gemini, then paste the repaint back at the same coordinates. The
  // model only ever sees one sign, so it can't put the reference on the
  // wrong post — the failure mode of the whole-image approach.
  async function runSignFixGenerate() {
    if (!inputAsset) {
      setStatus({
        state: "error",
        message: "Pick an image from the gallery first.",
      });
      return;
    }
    const complete = fixes.filter((f) => f.referenceUrl && f.region);
    if (complete.length === 0) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLatestUrl(null);
    try {
      setStatus({ state: "running", message: "reading source…" });
      const srcRel = relPathForAsset(folderName, externalRef, inputAsset);
      const srcBytes = await readFile(srcRel, {
        baseDir: BaseDirectory.Document,
      });
      const srcBitmap = await createImageBitmap(new Blob([srcBytes]));
      const W = srcBitmap.width;
      const H = srcBitmap.height;

      // Running canvas — each fix composites onto the result of the
      // previous one, so multiple signs accumulate into one final image.
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context unavailable");
      // High-quality resampling for the resize-back composite (the Gemini
      // crop is downscaled into the slot).
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(srcBitmap, 0, 0);
      srcBitmap.close();

      // Debug (dev builds only): dump each sign's sent crop, reference and
      // raw Gemini return into debug/<timestamp>/ so we can inspect what the
      // model produced before the resize-back composite.
      const DEBUG_SIGN_FIX = import.meta.env.DEV;
      let debugDir: string | null = null;
      if (DEBUG_SIGN_FIX) {
        const debugStamp = new Date().toISOString().replace(/[:.]/g, "-");
        debugDir = `${qdir(folderName, externalRef)}/debug/${debugStamp}`;
        await mkdir(debugDir, {
          baseDir: BaseDirectory.Document,
          recursive: true,
        });
      }

      // Margin around each region as a FRACTION OF THE REGION (not the
      // image) so the crop scales with the sign. An image-relative pad was
      // huge for a small sign (~100px on a 2560px image) and pulled
      // neighbouring signs — which often cluster on one post — into the
      // crop, leaving Gemini unable to tell which sign to repaint (it
      // returned the crop unchanged).
      const PAD_FRAC = 0.2;

      for (let i = 0; i < complete.length; i += 1) {
        const fix = complete[i];
        const region = fix.region as Rect;
        const label = `sign ${i + 1}/${complete.length}`;

        // Padded pixel bbox, clamped to image bounds. Pad scales with the
        // region so it stays tight around the marked sign.
        const padX = region.w * PAD_FRAC;
        const padY = region.h * PAD_FRAC;
        const px0 = Math.max(0, Math.round((region.x - padX) * W));
        const py0 = Math.max(0, Math.round((region.y - padY) * H));
        const px1 = Math.min(W, Math.round((region.x + region.w + padX) * W));
        const py1 = Math.min(H, Math.round((region.y + region.h + padY) * H));
        const pw = Math.max(1, px1 - px0);
        const ph = Math.max(1, py1 - py0);

        // Expand the crop to the nearest Gemini aspect preset. Gemini only
        // returns one of a few preset ratios; if we sent a preset but
        // composited the result back into a differently-shaped slot, the
        // sign would be squashed. Growing the crop (centred, clamped to
        // bounds) so its own shape IS the preset means send-aspect ==
        // slot-aspect == return-aspect → no distortion.
        const preset = nearestPreset(pw / ph);
        let ew = pw;
        let eh = ph;
        if (pw / ph > preset.ratio) {
          eh = Math.round(pw / preset.ratio);
        } else {
          ew = Math.round(ph * preset.ratio);
        }
        ew = Math.min(ew, W);
        eh = Math.min(eh, H);
        let sx = Math.round(px0 - (ew - pw) / 2);
        let sy = Math.round(py0 - (eh - ph) / 2);
        sx = Math.max(0, Math.min(sx, W - ew));
        sy = Math.max(0, Math.min(sy, H - eh));
        const sw = ew;
        const sh = eh;
        // Clamping ew/eh to the image bounds (sign near an edge/corner) can
        // break the target preset ratio, so re-snap to the actual post-clamp
        // shape — otherwise Gemini returns the old preset's aspect and the
        // composite squashes it into the differently-shaped slot.
        const effectivePreset = nearestPreset(sw / sh);

        // Upscale the crop to a minimum size before sending to Gemini. A
        // small sign is only ~90px even on a 2560px image, and Gemini
        // "frames" a tiny input like a card — a white rounded border that
        // then shows as a box when composited back. A larger crop reads as a
        // scene excerpt and is left unframed. Bilinear upscale is fine:
        // Gemini repaints the sign from the vector-crisp reference, not from
        // the crop's own detail.
        const CROP_FLOOR = 512;
        const scaleUp = Math.max(1, CROP_FLOOR / Math.min(sw, sh));
        const sendW = Math.round(sw * scaleUp);
        const sendH = Math.round(sh * scaleUp);

        // Reference rendered at the sign's pixel size IN THE SENT crop (so
        // ref scale matches the target after the upscale). A reference far
        // larger or smaller than the sign makes Gemini distort the symbol.
        setStatus({ state: "running", message: `${label}: fetching reference…` });
        const signPx = Math.min(
          768,
          Math.max(
            96,
            Math.round(Math.max(region.w * W, region.h * H) * scaleUp),
          ),
        );
        const ref = await fetchReferenceInline(
          fix.referenceUrl as string,
          controller.signal,
          signPx,
        );
        if (controller.signal.aborted) return;

        const cropCanvas = document.createElement("canvas");
        cropCanvas.width = sendW;
        cropCanvas.height = sendH;
        const cctx = cropCanvas.getContext("2d");
        if (!cctx) throw new Error("canvas 2d context unavailable");
        cctx.imageSmoothingEnabled = true;
        cctx.imageSmoothingQuality = "high";
        cctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sendW, sendH);
        const cropB64 = cropCanvas.toDataURL("image/png").split(",")[1] ?? "";

        setStatus({ state: "running", message: `${label}: Gemini…` });
        const out = await runGeminiCropEdit({
          crop: { mime_type: "image/png", data: cropB64 },
          reference: ref,
          prompt: prompt.trim() || "Match the sign to the reference.",
          aspectRatio: effectivePreset.label,
        });
        if (controller.signal.aborted) return;

        // Debug dump: crop we sent, the reference, and Gemini's raw return.
        if (DEBUG_SIGN_FIX && debugDir) {
          const n = i + 1;
          const refExt =
            ref.mime_type.split("/")[1]?.replace("+xml", "") || "png";
          await writeFile(
            `${debugDir}/sign-${n}-crop.png`,
            base64ToBytes(cropB64),
            { baseDir: BaseDirectory.Document },
          );
          await writeFile(
            `${debugDir}/sign-${n}-ref.${refExt}`,
            base64ToBytes(ref.data),
            { baseDir: BaseDirectory.Document },
          );
          await writeFile(
            `${debugDir}/sign-${n}-out.png`,
            base64ToBytes(out.dataB64),
            { baseDir: BaseDirectory.Document },
          );
        }

        // Returned crop is at the preset aspect = the slot aspect, so the
        // resize back into (sx,sy,sw,sh) is a clean fit, not a squash.
        const outImg = await loadImageFromBase64(out.dataB64, out.mimeType);
        ctx.drawImage(outImg, 0, 0, outImg.width, outImg.height, sx, sy, sw, sh);
      }

      if (controller.signal.aborted) return;
      setStatus({ state: "running", message: "saving…" });
      await ensureWorkdir(folderName, externalRef);
      const finalB64 = canvas.toDataURL("image/png").split(",")[1] ?? "";
      const newId = newAssetId();
      const filename = generateAssetFilename({
        id: newId,
        kind: "image",
        hint: "frame",
        ext: "png",
      });
      const rel = `${qdir(folderName, externalRef)}/${filename}`;
      await writeFile(rel, base64ToBytes(finalB64), {
        baseDir: BaseDirectory.Document,
      });

      const newAsset: Asset = {
        id: newId,
        kind: "image",
        originKind: "transform",
        engine: "gemini",
        filename,
        label: `Sign fix: ${complete.length} sign${
          complete.length > 1 ? "s" : ""
        }`,
        prompt: prompt.trim() || undefined,
        parentAssetIds: [inputAsset.id],
        createdAt: Date.now(),
      };
      await onSave(newAsset);
      setLatestUrl(await asset(rel));
      if (DEBUG_SIGN_FIX && debugDir) {
        console.log("[sign-fix] debug crops:", await absPath(debugDir));
      }
      setStatus({ state: "done", message: "saved to gallery" });
    } catch (e) {
      // A superseded run (a newer Generate aborted this one) must not
      // clobber the newer run's status with its own error/idle.
      if (controller.signal.aborted) return;
      if ((e as Error).name === "AbortError") {
        setStatus({ state: "idle" });
        return;
      }
      setStatus({ state: "error", message: errorMessage(e) });
    }
  }

  function handleGenerate() {
    if (signFixMode) {
      void runSignFixGenerate();
    } else {
      void generate();
    }
  }

  // Image enhance — SeedVR2 upscale (+ crop to 1280×800) or Clarity polish.
  // Both produce a new, UNLOCKED image asset (originKind "enhance") so the
  // admin can iterate/delete — unlike the role-locked variants pulled from
  // Rails. Mirrors the mastra pipeline's models/inputs.
  async function runEnhanceGenerate(model: "seedvr2" | "clarity") {
    if (!inputAsset) {
      setStatus({
        state: "error",
        message: "Pick an image from the gallery first.",
      });
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLatestUrl(null);

    const name = model === "seedvr2" ? "SeedVR2" : "Clarity";
    try {
      // Resolve input URL — public CDN if available, else upload the local
      // file (a stored remoteUrl may be an expired Replicate Files link).
      let imageUrl: string;
      if (inputAssetPublicUrl) {
        imageUrl = inputAssetPublicUrl;
      } else {
        setStatus({ state: "running", message: "uploading image…" });
        const localAbs = await absPath(
          relPathForAsset(folderName, externalRef, inputAsset),
        );
        imageUrl = await uploadFileToReplicate(localAbs);
        if (controller.signal.aborted) return;
      }

      const onTick = (p: Prediction<string>) =>
        setStatus({ state: "running", message: `${name} ${p.status}…` });

      await ensureWorkdir(folderName, externalRef);
      const newId = newAssetId();
      const filename = generateAssetFilename({
        id: newId,
        kind: "image",
        hint: "enhanced",
        ext: "png",
      });
      const rel = `${qdir(folderName, externalRef)}/${filename}`;

      let label: string;
      let engine: "seedvr2" | "clarity";

      if (model === "seedvr2") {
        setStatus({ state: "running", message: `${name}…` });
        const resultUrl = await runSeedVR2(imageUrl, {
          signal: controller.signal,
          onTick,
        });
        if (controller.signal.aborted) return;

        // Cover-crop to 1280×800 (mirrors the mastra pipeline's sharp crop).
        setStatus({ state: "running", message: "cropping to 1280×800…" });
        const res = await tauriFetch(resultUrl, { signal: controller.signal });
        if (!res.ok) throw new Error(`${name} download failed: ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const bitmap = await createImageBitmap(new Blob([bytes]));
        if (controller.signal.aborted) {
          bitmap.close();
          return;
        }
        const TW = 1280;
        const TH = 800;
        const canvas = document.createElement("canvas");
        canvas.width = TW;
        canvas.height = TH;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas 2d context unavailable");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        const scale = Math.max(TW / bitmap.width, TH / bitmap.height);
        const dw = bitmap.width * scale;
        const dh = bitmap.height * scale;
        ctx.drawImage(bitmap, (TW - dw) / 2, (TH - dh) / 2, dw, dh);
        bitmap.close();
        const b64 = canvas.toDataURL("image/png").split(",")[1] ?? "";
        await writeFile(rel, base64ToBytes(b64), {
          baseDir: BaseDirectory.Document,
        });
        label = "Enlarge & sharpen";
        engine = "seedvr2";
      } else {
        setStatus({ state: "running", message: `${name}…` });
        const resultUrl = await runClarity(imageUrl, {
          signal: controller.signal,
          onTick,
        });
        if (controller.signal.aborted) return;
        setStatus({ state: "running", message: "downloading…" });
        await downloadInto({
          folderName,
          externalRef,
          filename,
          url: resultUrl,
          signal: controller.signal,
        });
        label = "Polish detail";
        engine = "clarity";
      }
      if (controller.signal.aborted) return;

      const newAsset: Asset = {
        id: newId,
        kind: "image",
        originKind: "enhance",
        engine,
        filename,
        label,
        parentAssetIds: [inputAsset.id],
        createdAt: Date.now(),
      };
      await onSave(newAsset);
      setLatestUrl(await asset(rel));
      setStatus({ state: "done", message: "saved to gallery" });
    } catch (e) {
      if (controller.signal.aborted) return;
      if ((e as Error).name === "AbortError") {
        setStatus({ state: "idle" });
        return;
      }
      setStatus({ state: "error", message: errorMessage(e) });
    }
  }

  function handleEnhance(model: "seedvr2" | "clarity") {
    void runEnhanceGenerate(model);
  }

  const generateDisabled =
    status.state === "running" ||
    (signFixMode ? completeFixes.length === 0 : !prompt.trim());

  let generateLabel: string;
  if (status.state === "running") {
    generateLabel = signFixMode ? "Fixing signs…" : "Editing…";
  } else if (signFixMode) {
    generateLabel = `Fix ${completeFixes.length} sign${
      completeFixes.length > 1 ? "s" : ""
    } via Gemini`;
  } else {
    generateLabel = `Generate edit · ≈$${FLUX_KONTEXT_COST_USD.toFixed(2)}`;
  }

  // Regions for the picker — one coloured rectangle per fix that has a
  // region, numbered/coloured to match its row in the list.
  const pickerRegions: PickerRegion[] = fixes
    .map((f, i) =>
      f.region
        ? { id: f.id, rect: f.region, color: fixColor(i), label: String(i + 1) }
        : null,
    )
    .filter((r): r is PickerRegion => r !== null);
  const activeFixIndex = fixes.findIndex((f) => f.id === activeFixId);
  const activeColor = activeFixIndex >= 0 ? fixColor(activeFixIndex) : "#818cf8";

  return (
   <>
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Edit image</h2>
        <StatusPill state={status.state} message={status.message} />
      </header>

      {!inputAsset ? (
        <div className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-950 p-8 text-center text-sm text-neutral-500">
          Pick an image from the sidebar to edit.
        </div>
      ) : (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-6">
          <div className="mb-4 flex items-start gap-4">
            {inputAssetThumbUrl && (
              <img
                src={inputAssetThumbUrl}
                alt={inputAsset.label}
                onClick={() => setLightboxSrc(inputAssetThumbUrl)}
                title="Click to view full screen"
                className="h-56 aspect-video cursor-zoom-in rounded-lg border border-neutral-800 object-cover"
              />
            )}
            <div>
              <p className="text-xs uppercase tracking-wide text-neutral-500">
                Source image
              </p>
              <p className="mt-1 text-sm text-neutral-200">{inputAsset.label}</p>
              {!inputAssetPublicUrl && (
                <p className="mt-1 text-[11px] text-neutral-500">
                  Local asset — will be uploaded to Replicate before
                  Flux runs.
                </p>
              )}
            </div>
          </div>

          {/* Mode toggle — Edit (Flux/Gemini sign-fix) vs Enhance (SeedVR2
              upscale + Clarity polish). Both are image→image operations. */}
          <div className="mb-4 inline-flex gap-0.5 rounded-lg border border-neutral-800 bg-neutral-900 p-0.5 text-xs">
            <button
              onClick={() => setMode("edit")}
              className={`rounded-md px-3 py-1 ${
                mode === "edit"
                  ? "bg-neutral-700 text-white"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              🪄 Edit
            </button>
            <button
              onClick={() => setMode("enhance")}
              className={`rounded-md px-3 py-1 ${
                mode === "enhance"
                  ? "bg-neutral-700 text-white"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              🔼 Enhance
            </button>
          </div>

          {mode === "enhance" ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
              <p className="mb-1 text-xs uppercase tracking-wide text-neutral-400">
                Enhance image
              </p>
              <p className="mb-4 text-[11px] text-neutral-500">
                Make the image larger and crisper. Each saves a new image asset
                linked to the source.
              </p>

              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <Button
                    onClick={() => handleEnhance("seedvr2")}
                    disabled={status.state === "running"}
                    className="w-44 shrink-0 justify-center"
                  >
                    ⬆ Enlarge &amp; sharpen
                  </Button>
                  <p className="text-[11px] leading-relaxed text-neutral-400">
                    Turns a small, soft image into a large sharp one and crops it
                    to 1280×800. <span className="text-neutral-600">(SeedVR2)</span>
                  </p>
                </div>

                <div className="flex items-start gap-3">
                  <Button
                    onClick={() => handleEnhance("clarity")}
                    disabled={status.state === "running"}
                    className="w-44 shrink-0 justify-center"
                  >
                    ✨ Polish detail
                  </Button>
                  <p className="text-[11px] leading-relaxed text-neutral-400">
                    Adds extra crispness and fine detail to an image.{" "}
                    <span className="text-neutral-600">(Clarity)</span>
                  </p>
                </div>
              </div>
            </div>
          ) : (
          <>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-neutral-500">
              Edit instruction
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => onOpenLibrary("browse")}
                className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                title="Browse saved edit prompts"
              >
                📚 Library
              </button>
              <button
                onClick={() => onOpenLibrary("save")}
                disabled={!prompt.trim()}
                className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
                title="Save this edit prompt to the library"
              >
                💾 Save
              </button>
            </div>
          </div>
          <Textarea
            value={prompt}
            onChange={onPromptChange}
            rows={6}
            placeholder='e.g. "remove the yellow arrows on the road" — keep instructions direct, single-edit. The AI panel on the right can help if you describe what bothers you in the image.'
          />

          {/* Sign-fix (optional) — one fix per sign: pair its correct
              reference with the region it occupies. Each fix is repaired
              independently (crop → Gemini → composite), so the model can't
              put a reference on the wrong sign. */}
          <div className="mt-6 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-neutral-400">
                Sign fix · optional
              </span>
              {signFixMode && (
                <span className="rounded-full bg-indigo-900/40 px-2 py-0.5 text-[10px] text-indigo-300">
                  Gemini mode · {completeFixes.length} ready
                </span>
              )}
            </div>
            <p className="mb-3 text-[11px] text-neutral-500">
              Super-resolution sharpens the image but mangles signs. For each
              sign, add its correct reference and mark where it is — Gemini
              fixes one sign at a time so it can't swap them.
            </p>

            <SignFixList
              fixes={fixes}
              activeId={activeFixId}
              onChange={setFixes}
              onSelect={setActiveFixId}
              loadableCount={questionSigns.length}
              onLoadFromQuestion={loadSignsFromQuestion}
            />

            {fixes.length > 0 &&
              (inputAssetThumbUrl ? (
                <div className="mt-4">
                  <div className="mb-1 flex items-center justify-between">
                    <p className="text-[11px] text-neutral-500">
                      {activeFixId
                        ? `Drag on the image to mark sign #${activeFixIndex + 1}`
                        : "Pick a fix's “mark region” above, then drag on the image"}
                    </p>
                    <button
                      onClick={() => setLightboxSrc(inputAssetThumbUrl)}
                      className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                      title="Inspect the image full screen (zoom in to find the sign)"
                    >
                      ⤢ Full screen
                    </button>
                  </div>
                  <SignRegionPicker
                    imageUrl={inputAssetThumbUrl}
                    regions={pickerRegions}
                    activeId={activeFixId}
                    activeColor={activeColor}
                    onDraw={setActiveRegion}
                  />
                </div>
              ) : (
                <p className="mt-3 text-[11px] text-neutral-600">
                  No preview available for this asset — region marking needs a
                  visible image.
                </p>
              ))}
          </div>

          <div className="mt-4 flex items-center gap-3">
            <Button onClick={handleGenerate} disabled={generateDisabled}>
              {generateLabel}
            </Button>
            <p className="text-[11px] text-neutral-500">
              {signFixMode
                ? "Gemini repaints the signs to match the references — saved as a new image linked to the source."
                : "Result saves as a new image asset linked to the source — the original stays untouched."}
            </p>
          </div>

          {/* Memory-anchor caveat — pedagogical note, only shown when
              the source is the workspace's exam image. Editing
              extracted frames / prior transforms doesn't have the same
              concern. */}
          {inputAsset.role === "source" && (
            <p className="mt-3 rounded-lg border border-amber-900/40 bg-amber-950/20 p-3 text-[11px] text-amber-200">
              ⚠ The exam shows the original image to students with the
              yellow arrows / annotations. Removing them produces a
              cleaner animation but the explanation no longer starts
              from the literal exam frame the student remembers.
            </p>
          )}
          </>
          )}

          {latestUrl && (
            <div className="mt-4">
              <p className="mb-1 text-xs text-neutral-500">Latest edit:</p>
              <img
                src={latestUrl}
                alt="edited image"
                onClick={() => setLightboxSrc(latestUrl)}
                title="Click to view full screen"
                className="max-h-64 cursor-zoom-in rounded-lg border border-neutral-800"
              />
            </div>
          )}
        </div>
      )}
    </div>
    {lightboxSrc && (
      <ImageLightbox
        src={lightboxSrc}
        alt="source"
        onClose={() => setLightboxSrc(null)}
      />
    )}
   </>
  );
}
