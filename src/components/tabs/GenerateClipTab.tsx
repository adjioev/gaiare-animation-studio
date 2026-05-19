// Generate-clip tab — picks one image asset as the start frame, runs
// Wan 2.2 i2v fast with the contractor's prompt, previews the result,
// commits to the workspace assets on "Save".
//
// "Generate" creates a transient preview file; rerunning replaces it
// without polluting the asset gallery. "Save" promotes the current
// preview into a permanent named asset (with prompt + parent recorded).

import { useEffect, useState } from "react";
import { BaseDirectory, rename } from "@tauri-apps/plugin-fs";
import { runWan, type Prediction } from "../../lib/replicate";
import {
  absPath,
  asset,
  downloadInto,
  ensureWorkdir,
} from "../../lib/workdir";
import { probeDurationSeconds } from "../../lib/ffmpeg";
import {
  Button,
  Field,
  StatusPill,
  Textarea,
  errorMessage,
  type StatusState,
} from "../ui";
import {
  generateAssetFilename,
  newAssetId,
  relPathForAsset,
  type Asset,
} from "../../lib/workspace";

type Status = { state: StatusState; message?: string };
const IDLE: Status = { state: "idle" };

export function GenerateClipTab({
  externalRef,
  selectedImage,
  selectedImagePublicUrl,
  selectedImageThumbUrl,
  defaultPrompt,
  onSave,
}: {
  externalRef: string;
  selectedImage: Asset | null;
  /** Publicly reachable URL for the selected image — Wan requires a URL
   *  the model server can fetch, not a local path. For the bootstrap
   *  source image this is the original CDN URL. For derived assets
   *  (e.g. an extracted mid-frame) the contractor will need an upload
   *  step before this tab can consume them; that's a follow-up. */
  selectedImagePublicUrl: string | null;
  /** `asset://`-style URL the webview can render in an `<img>` tag.
   *  Built by App so the cache-busting query param stays in one place. */
  selectedImageThumbUrl: string | null;
  defaultPrompt: string;
  onSave: (asset: Asset) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [status, setStatus] = useState<Status>(IDLE);
  const [previewRelPath, setPreviewRelPath] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewDuration, setPreviewDuration] = useState<number | null>(null);

  // Reset preview when the selected start image changes — the old
  // preview was generated against a different frame and is now stale.
  useEffect(() => {
    setPreviewRelPath(null);
    setPreviewUrl(null);
    setPreviewDuration(null);
    setStatus(IDLE);
  }, [selectedImage?.id]);

  async function generate() {
    if (!selectedImagePublicUrl) {
      setStatus({
        state: "error",
        message: "Selected image has no public URL (upload pipeline pending)",
      });
      return;
    }
    setStatus({ state: "running", message: "Replicate (Wan 2.2 i2v fast)…" });
    setPreviewUrl(null);

    try {
      const url = await runWan(
        { image: selectedImagePublicUrl, prompt },
        {
          onTick: (p: Prediction<string>) =>
            setStatus({
              state: "running",
              message: `replicate ${p.status}…`,
            }),
        },
      );

      setStatus({ state: "running", message: "downloading…" });
      await ensureWorkdir(externalRef);
      const rel = await downloadInto({
        externalRef,
        filename: "preview-clip.mp4",
        url,
      });
      setPreviewRelPath(rel);
      setPreviewUrl(await asset(rel));

      try {
        const dur = await probeDurationSeconds(await absPath(rel));
        setPreviewDuration(dur);
      } catch {
        setPreviewDuration(null);
      }

      setStatus({ state: "done", message: "preview ready — save to keep" });
    } catch (e) {
      setStatus({ state: "error", message: errorMessage(e) });
    }
  }

  async function save() {
    if (!previewRelPath || !selectedImage) return;
    const id = newAssetId();
    const filename = generateAssetFilename({
      id,
      kind: "video",
      hint: "clip",
    });
    const targetRel = relPathForAsset(externalRef, {
      id,
      kind: "video",
      filename,
    } as Asset);

    // Rename via tauri-plugin-fs (avoids shelling out to `mv` which
    // isn't in the shell allowlist).
    await rename(previewRelPath, targetRel, {
      oldPathBaseDir: BaseDirectory.Document,
      newPathBaseDir: BaseDirectory.Document,
    });

    const newAsset: Asset = {
      id,
      kind: "video",
      filename,
      label: shortLabel(prompt),
      prompt,
      parentAssetIds: [selectedImage.id],
      durationSec: previewDuration ?? undefined,
      createdAt: Date.now(),
    };
    await onSave(newAsset);

    // After save, the preview is gone — show the saved asset's URL.
    setPreviewRelPath(targetRel);
    setPreviewUrl(await asset(targetRel));
    setStatus({ state: "done", message: "saved to gallery" });
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Generate clip</h2>
        <StatusPill state={status.state} message={status.message} />
      </header>

      {!selectedImage ? (
        <div className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-950 p-8 text-center text-sm text-neutral-500">
          Pick an image from the sidebar to use as the start frame.
        </div>
      ) : (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-6">
          <div className="mb-4 flex items-start gap-4">
            {selectedImageThumbUrl && (
              <img
                src={selectedImageThumbUrl}
                alt={selectedImage.label}
                className="h-32 w-48 rounded-lg border border-neutral-800 object-cover"
              />
            )}
            <div>
              <p className="text-xs uppercase tracking-wide text-neutral-500">
                Start frame
              </p>
              <p className="mt-1 text-sm text-neutral-200">
                {selectedImage.label}
              </p>
              {selectedImagePublicUrl && (
                <p className="mt-1 break-all text-[10px] text-neutral-600">
                  {selectedImagePublicUrl}
                </p>
              )}
            </div>
          </div>

          <Field label="Prompt">
            <Textarea value={prompt} onChange={setPrompt} rows={10} />
          </Field>

          <div className="mt-4 flex items-center gap-3">
            <Button onClick={generate}>Generate</Button>
            <Button
              variant="secondary"
              onClick={save}
              disabled={!previewRelPath}
            >
              Save to assets
            </Button>
            {previewDuration && (
              <span className="text-xs text-neutral-500">
                preview: {previewDuration.toFixed(2)} s
              </span>
            )}
          </div>

          {previewUrl && (
            <video
              src={previewUrl}
              controls
              className="mt-4 w-full max-w-2xl rounded-lg border border-neutral-800"
            />
          )}
        </div>
      )}
    </div>
  );
}

function shortLabel(prompt: string): string {
  const firstLine = prompt.trim().split("\n")[0] ?? "";
  return firstLine.length > 60
    ? `${firstLine.slice(0, 57)}…`
    : firstLine || "Generated clip";
}

