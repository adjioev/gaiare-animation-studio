// Trim-clip panel — UX MOCK. Range slider with two handles, video
// preview with start/end markers, length readout. The "Save trimmed
// clip" button is intentionally disabled — ffmpeg wiring lands after
// UX approval.

import { useEffect, useRef, useState } from "react";
import { absPath, asset } from "../../lib/workdir";
import { probeDurationSeconds, trimClip } from "../../lib/ffmpeg";
import { Button, StatusPill, errorMessage, type StatusState } from "../ui";
import {
  generateAssetFilename,
  newAssetId,
  relPathForAsset,
  type Asset,
} from "../../lib/workspace";

type Status = { state: StatusState; message?: string };

export function TrimClipTab({
  folderName,
  externalRef,
  inputVideo,
  inputVideoUrl,
  trimStart,
  trimEnd,
  onTrimChange,
  onSave,
}: {
  folderName: string;
  externalRef: string;
  inputVideo: Asset | null;
  inputVideoUrl: string | null;
  trimStart: number | null;
  trimEnd: number | null;
  onTrimChange: (start: number, end: number) => void;
  onSave: (asset: Asset) => Promise<void>;
}) {
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [durationSec, setDurationSec] = useState<number | null>(null);
  const [savedClipUrl, setSavedClipUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Reset session state when input video changes.
  useEffect(() => {
    setStatus({ state: "idle" });
    setDurationSec(inputVideo?.durationSec ?? null);
    setSavedClipUrl(null);
  }, [inputVideo?.id]);

  // Render-time effective range — fall back to full clip [0, duration]
  // on first mount before persistence has seeded.
  const effectiveStart = trimStart ?? 0;
  const effectiveEnd = trimEnd ?? durationSec ?? 5;
  const clipLength = Math.max(0, effectiveEnd - effectiveStart);

  // Range slider — two `<input type="range">` stacked. The visible
  // "selected" band is drawn behind them as a colored div. Each input
  // clamps against the other so handles can't cross.
  const MIN_GAP_SEC = 0.1;

  function handleStartChange(next: number) {
    if (!durationSec) return;
    const clamped = Math.max(0, Math.min(next, effectiveEnd - MIN_GAP_SEC));
    onTrimChange(clamped, effectiveEnd);
    // Scrub video preview to the new start so the contractor sees the
    // first kept frame.
    if (videoRef.current) videoRef.current.currentTime = clamped;
  }

  function handleEndChange(next: number) {
    if (!durationSec) return;
    const clamped = Math.min(
      durationSec,
      Math.max(next, effectiveStart + MIN_GAP_SEC),
    );
    onTrimChange(effectiveStart, clamped);
    if (videoRef.current) videoRef.current.currentTime = clamped;
  }

  // Position percentages for the filled "selected" band.
  const pctStart =
    durationSec && durationSec > 0
      ? (effectiveStart / durationSec) * 100
      : 0;
  const pctEnd =
    durationSec && durationSec > 0
      ? (effectiveEnd / durationSec) * 100
      : 100;

  /** Trim the input clip to [start, end] and save the result as a new
   *  video asset. The source clip is never modified — the new asset's
   *  `parentAssetIds` references the original so the genealogy
   *  (image → clip → trimmed) is queryable later. */
  async function saveTrim() {
    if (!inputVideo || !durationSec) return;
    if (clipLength < 0.1) {
      setStatus({ state: "error", message: "Trim length must be ≥ 0.1 s" });
      return;
    }
    setStatus({ state: "running", message: "ffmpeg trimming…" });
    const id = newAssetId();
    const filename = generateAssetFilename({ id, kind: "video", hint: "clip" });
    const targetRel = relPathForAsset(folderName, externalRef, {
      id,
      kind: "video",
      filename,
    } as Asset);
    try {
      const inAbs = await absPath(
        relPathForAsset(folderName, externalRef, inputVideo),
      );
      const outAbs = await absPath(targetRel);
      await trimClip({
        videoAbsPath: inAbs,
        startSeconds: effectiveStart,
        endSeconds: effectiveEnd,
        outputAbsPath: outAbs,
      });
      const newAsset: Asset = {
        id,
        kind: "video",
        filename,
        label: `Trim ${effectiveStart.toFixed(1)}–${effectiveEnd.toFixed(1)}s of ${inputVideo.label}`,
        parentAssetIds: [inputVideo.id],
        durationSec: clipLength,
        createdAt: Date.now(),
      };
      // Awaited persistence — see autosave-race note in App.tsx.
      await onSave(newAsset);
      // Cache-bust — the gallery may have rendered a different video
      // at the same asset:// URL during a previous session, and the
      // WebView aggressively caches asset URLs by path.
      setSavedClipUrl(`${await asset(targetRel)}?t=${Date.now()}`);
      setStatus({ state: "done", message: "saved to gallery" });
    } catch (e) {
      setStatus({ state: "error", message: errorMessage(e) });
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Trim clip</h2>
        <StatusPill state={status.state} message={status.message} />
      </header>

      {!inputVideo ? (
        <div className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-950 p-8 text-center text-sm text-neutral-500">
          Pick a video from the sidebar to trim.
        </div>
      ) : (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-6">
          <p className="mb-3 text-xs uppercase tracking-wide text-neutral-500">
            Source video · {inputVideo.label}
          </p>

          {inputVideoUrl && (
            <video
              ref={videoRef}
              src={inputVideoUrl}
              preload="auto"
              muted
              playsInline
              onLoadedMetadata={async (e) => {
                let d = e.currentTarget.duration;
                if (!Number.isFinite(d) || d <= 0) {
                  if (inputVideo) {
                    try {
                      const abs = await absPath(
                        relPathForAsset(folderName, externalRef, inputVideo),
                      );
                      d = await probeDurationSeconds(abs);
                    } catch (err) {
                      setStatus({ state: "error", message: errorMessage(err) });
                      return;
                    }
                  } else {
                    return;
                  }
                }
                setDurationSec(d);
                // Seed default range to full clip when nothing persisted.
                if (trimStart === null || trimEnd === null) {
                  onTrimChange(0, d);
                }
              }}
              className="w-full max-w-2xl rounded-lg border border-neutral-800"
            />
          )}

          {/* Range slider — visible track + filled band + two transparent
              range inputs stacked on top. The inputs share the same
              geometry so their thumbs sit on the same line. */}
          <div className="mt-4">
            <div className="relative h-8">
              {/* Track */}
              <div className="absolute top-1/2 left-0 right-0 h-1.5 -translate-y-1/2 rounded-full bg-neutral-800" />
              {/* Selected band */}
              <div
                className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-indigo-500"
                style={{
                  left: `${pctStart}%`,
                  width: `${pctEnd - pctStart}%`,
                }}
              />
              {/* Inputs — transparent thumbs over the track. Both share
                  the same min/max so percentage math lines up. */}
              <input
                type="range"
                min={0}
                max={durationSec ?? 5}
                step={1 / 60}
                value={effectiveStart}
                onChange={(e) => handleStartChange(Number(e.currentTarget.value))}
                className="trim-slider absolute inset-0 w-full appearance-none bg-transparent"
                aria-label="Trim start"
              />
              <input
                type="range"
                min={0}
                max={durationSec ?? 5}
                step={1 / 60}
                value={effectiveEnd}
                onChange={(e) => handleEndChange(Number(e.currentTarget.value))}
                className="trim-slider absolute inset-0 w-full appearance-none bg-transparent"
                aria-label="Trim end"
              />
            </div>

            <div className="mt-2 flex items-center justify-between font-mono text-xs text-neutral-400">
              <span>start {effectiveStart.toFixed(2)}s</span>
              <span className="text-neutral-200">
                length {clipLength.toFixed(2)}s
                {durationSec && (
                  <span className="ml-1 text-neutral-500">
                    (was {durationSec.toFixed(2)}s)
                  </span>
                )}
              </span>
              <span>end {effectiveEnd.toFixed(2)}s</span>
            </div>
          </div>

          <div className="mt-6">
            <Button
              onClick={saveTrim}
              disabled={!durationSec || status.state === "running"}
            >
              {status.state === "running"
                ? "Trimming…"
                : "Save trimmed clip to assets"}
            </Button>
          </div>

          <p className="mt-4 text-xs text-neutral-500">
            Drag the two handles to set the keep-range. Video scrubs to
            whichever handle you last moved so you can see the first /
            last frame of the trimmed clip.
          </p>

          {savedClipUrl && (
            <div className="mt-4">
              <p className="mb-1 text-xs text-neutral-500">Last trimmed clip:</p>
              <video
                src={savedClipUrl}
                controls
                muted
                playsInline
                className="max-h-64 rounded-lg border border-neutral-800"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
