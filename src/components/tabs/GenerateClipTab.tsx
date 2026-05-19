// Generate-clip panel — controlled component. Persisted state (input
// asset + prompt) lives on the parent so closing/reopening tabs doesn't
// lose work. Session state (generation status, latest-preview URL) is
// local because it's regenerable and shouldn't bloat workspace.json.
// Every successful generation auto-saves as a new video asset; the
// `previewUrl` is just the most-recent one for in-tab playback.

import { useEffect, useRef, useState } from "react";
import {
  runWan,
  uploadFileToReplicate,
  type Prediction,
} from "../../lib/replicate";
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

export function GenerateClipTab({
  folderName,
  externalRef,
  inputAsset,
  inputAssetPublicUrl,
  inputAssetThumbUrl,
  prompt,
  onPromptChange,
  onSave,
}: {
  folderName: string;
  externalRef: string;
  inputAsset: Asset | null;
  inputAssetPublicUrl: string | null;
  inputAssetThumbUrl: string | null;
  prompt: string;
  onPromptChange: (next: string) => void;
  onSave: (asset: Asset) => Promise<void>;
}) {
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewDuration, setPreviewDuration] = useState<number | null>(null);
  // AbortController for the in-flight Replicate call. Reset between
  // generations; aborted when the tab unmounts (close, switch
  // workspace) so partial work doesn't leak ghost saves.
  const abortRef = useRef<AbortController | null>(null);

  // Reset preview when the input asset changes (the old preview was
  // produced against a different start frame and is now stale).
  useEffect(() => {
    setPreviewUrl(null);
    setPreviewDuration(null);
    setStatus({ state: "idle" });
  }, [inputAsset?.id]);

  // Abort + clean up on unmount.
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
        message: "Pick an input image from the gallery first.",
      });
      return;
    }
    // If a generation is in flight, cancel it first — we're about to
    // start a fresh one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPreviewUrl(null);

    try {
      // Resolve the URL Wan will fetch the start frame from. The
      // workspace's source image already has a public CDN URL; every
      // other asset (extracted frames, trimmed clips) lives only on
      // disk and needs to be uploaded to Replicate's Files API first.
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

      setStatus({ state: "running", message: "Replicate (Wan 2.2 i2v fast)…" });
      const url = await runWan(
        { image: imageUrl, prompt },
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

      // Download straight into the canonical clip-<assetId>.mp4 file
      // and save the asset entry — no intermediate "preview"
      // step. Earlier flow required an explicit "Save to assets"
      // click to commit, which was friction for the dominant happy
      // path: the contractor usually wants every generation in the
      // gallery, and prunes bad ones with the × button.
      const newId = newAssetId();
      const filename = generateAssetFilename({
        id: newId,
        kind: "video",
        hint: "clip",
      });
      const rel = await downloadInto({
        folderName,
        externalRef,
        filename,
        url,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      // Save the asset BEFORE probing duration. ffprobe spawns a
      // subprocess and can take hundreds of ms; if the tab unmounts
      // (closeTab, switchWorkspace, app quit) during the probe the
      // controller aborts but the mp4 is already on disk — without
      // an earlier `onSave` it would be an orphan in workspace.json.
      // Probing afterwards patches durationSec via upsert.
      const newAsset: Asset = {
        id: newId,
        kind: "video",
        filename,
        label: shortLabel(prompt),
        prompt,
        parentAssetIds: [inputAsset.id],
        createdAt: Date.now(),
      };
      await onSave(newAsset);
      setPreviewUrl(await asset(rel));
      setStatus({ state: "done", message: "saved · probing duration…" });

      let durationSec: number | null = null;
      try {
        durationSec = await probeDurationSeconds(await absPath(rel));
      } catch {
        // probe failure is fine — duration is optional metadata
      }
      if (controller.signal.aborted) return;
      if (durationSec !== null) {
        await onSave({ ...newAsset, durationSec });
      }
      setPreviewDuration(durationSec);
      setStatus({
        state: "done",
        message: `saved · ${durationSec?.toFixed(1) ?? "?"}s`,
      });
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
        <h2 className="text-lg font-medium">Generate clip</h2>
        <StatusPill state={status.state} message={status.message} />
      </header>

      {!inputAsset ? (
        <div className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-950 p-8 text-center text-sm text-neutral-500">
          Pick an image from the sidebar to use as the start frame.
        </div>
      ) : (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-6">
          <div className="mb-4 flex items-start gap-4">
            {inputAssetThumbUrl && (
              <img
                src={inputAssetThumbUrl}
                alt={inputAsset.label}
                // h-56 + aspect-video = 224×398 ≈ Wan's 480p 16:9
                // output dimensions, so the start frame previews at
                // the same shape as the generated clip will be.
                className="h-56 aspect-video rounded-lg border border-neutral-800 object-cover"
              />
            )}
            <div>
              <p className="text-xs uppercase tracking-wide text-neutral-500">
                Start frame
              </p>
              <p className="mt-1 text-sm text-neutral-200">{inputAsset.label}</p>
              {inputAssetPublicUrl && (
                <p className="mt-1 break-all text-[10px] text-neutral-600">
                  {inputAssetPublicUrl}
                </p>
              )}
              {!inputAssetPublicUrl && (
                <p className="mt-1 text-[11px] text-neutral-500">
                  Local asset — will be uploaded to Replicate before Wan runs.
                </p>
              )}
            </div>
          </div>

          <Field label="Prompt">
            <Textarea
              value={prompt}
              onChange={onPromptChange}
              rows={10}
              placeholder="Open the AI panel on the right and describe what you want (e.g. &quot;red sedan turns left, van stays put&quot;), then click Apply to drop the generated prompt here. Or type directly if you know the structure."
            />
          </Field>

          <div className="mt-4 flex items-center gap-3">
            <Button onClick={generate} disabled={status.state === "running"}>
              {status.state === "running" ? "Generating…" : "Generate"}
            </Button>
            {previewDuration && status.state !== "running" && (
              <span className="text-xs text-neutral-500">
                latest · {previewDuration.toFixed(2)} s — saved to gallery
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
