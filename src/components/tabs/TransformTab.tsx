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
  runFluxKontext,
  uploadFileToReplicate,
  type Prediction,
} from "../../lib/replicate";
import {
  absPath,
  asset,
  downloadInto,
  ensureWorkdir,
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

type Status = { state: StatusState; message?: string };

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
}) {
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [latestUrl, setLatestUrl] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setLatestUrl(null);
    setStatus({ state: "idle" });
  }, [inputAsset?.id]);

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

  return (
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
                className="h-56 aspect-video rounded-lg border border-neutral-800 object-cover"
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

          <div className="mt-4 flex items-center gap-3">
            <Button
              onClick={generate}
              disabled={status.state === "running" || !prompt.trim()}
            >
              {status.state === "running"
                ? "Editing…"
                : `Generate edit · ≈$${FLUX_KONTEXT_COST_USD.toFixed(2)}`}
            </Button>
            <p className="text-[11px] text-neutral-500">
              Result saves as a new image asset linked to the source —
              the original stays untouched.
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

          {latestUrl && (
            <div className="mt-4">
              <p className="mb-1 text-xs text-neutral-500">Latest edit:</p>
              <img
                src={latestUrl}
                alt="edited image"
                className="max-h-64 rounded-lg border border-neutral-800"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
