// Generate-clip panel — controlled component. Persisted state (input
// asset + prompt) lives on the parent so closing/reopening tabs doesn't
// lose work. Session state (generation status, preview URL) is local
// because it's regenerable and shouldn't bloat workspace.json.

import { useEffect, useRef, useState } from "react";
import {
  BaseDirectory,
  exists,
  remove,
  rename,
} from "@tauri-apps/plugin-fs";
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
  tabId,
  folderName,
  externalRef,
  inputAsset,
  inputAssetPublicUrl,
  inputAssetThumbUrl,
  prompt,
  onPromptChange,
  onSave,
  onPreviewChange,
}: {
  tabId: string;
  folderName: string;
  externalRef: string;
  inputAsset: Asset | null;
  inputAssetPublicUrl: string | null;
  inputAssetThumbUrl: string | null;
  prompt: string;
  onPromptChange: (next: string) => void;
  onSave: (asset: Asset) => Promise<void>;
  onPreviewChange: (hasUnsavedPreview: boolean) => void;
}) {
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [previewRelPath, setPreviewRelPath] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewDuration, setPreviewDuration] = useState<number | null>(null);
  // Full UUID, not a 8-char prefix — birthday collisions at ~256 open
  // tabs would otherwise overwrite each other's preview file mid-write.
  const previewFilename = useRef(`preview-${tabId}.mp4`);
  // AbortController for the in-flight Replicate call. Reset between
  // generations; aborted when the tab unmounts (close, switch
  // workspace) so partial work doesn't leak ghost saves.
  const abortRef = useRef<AbortController | null>(null);

  // Reset preview when the input asset changes (the old preview was
  // produced against a different start frame and is now stale).
  useEffect(() => {
    setPreviewRelPath(null);
    setPreviewUrl(null);
    setPreviewDuration(null);
    setStatus({ state: "idle" });
    onPreviewChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // overwrite the preview file anyway.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPreviewUrl(null);
    onPreviewChange(false);

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
      const rel = await downloadInto({
        folderName,
        externalRef,
        filename: previewFilename.current,
        url,
        signal: controller.signal,
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
      onPreviewChange(true);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setStatus({ state: "idle" });
        return;
      }
      setStatus({ state: "error", message: errorMessage(e) });
    }
  }

  async function save() {
    if (!previewRelPath || !inputAsset) return;
    const id = newAssetId();
    const filename = generateAssetFilename({
      id,
      kind: "video",
      hint: "clip",
    });
    const targetRel = relPathForAsset(folderName, externalRef, {
      id,
      kind: "video",
      filename,
    } as Asset);

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
      parentAssetIds: [inputAsset.id],
      durationSec: previewDuration ?? undefined,
      createdAt: Date.now(),
    };
    // `onSave` MUST persist before returning — see the autosave-race
    // note in App.tsx. We await it so that if the user closes the tab
    // immediately after Save, the workspace.json already records this
    // asset (otherwise it would become an orphan file).
    await onSave(newAsset);

    setPreviewRelPath(targetRel);
    setPreviewUrl(await asset(targetRel));
    onPreviewChange(false);
    setStatus({ state: "done", message: "saved to gallery" });
  }

  // Best-effort cleanup of an orphaned preview file when the tab is
  // closed without saving. The exists-check tolerates races (rename
  // already happened) and the catch swallows fs errors (the next time
  // this tabId is reused, the file will be overwritten anyway).
  useEffect(() => {
    const filename = previewFilename.current;
    const ref = externalRef;
    const fn = folderName;
    return () => {
      void (async () => {
        try {
          const rel = `${fn}/q${ref}/${filename}`;
          if (await exists(rel, { baseDir: BaseDirectory.Document })) {
            await remove(rel, { baseDir: BaseDirectory.Document });
          }
        } catch {
          // ignore
        }
      })();
    };
    // We intentionally bind to the values at mount time; the preview
    // file name is keyed by `tabId` (immutable) and we don't want
    // changes to `folderName` mid-life to retarget the cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
                className="h-32 w-48 rounded-lg border border-neutral-800 object-cover"
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
            <Textarea value={prompt} onChange={onPromptChange} rows={10} />
          </Field>

          <div className="mt-4 flex items-center gap-3">
            <Button onClick={generate} disabled={status.state === "running"}>
              {status.state === "running" ? "Generating…" : "Generate"}
            </Button>
            <Button
              variant="secondary"
              onClick={save}
              disabled={!previewRelPath || status.state === "running"}
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
