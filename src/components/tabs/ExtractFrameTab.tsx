// Extract-frame panel — controlled component. Selected video and scrub
// position are persisted on the parent tab record; the scrubbing video
// element + ffmpeg invocation stay session-local.

import { useEffect, useRef, useState } from "react";
import { absPath, asset } from "../../lib/workdir";
import { extractFrame, probeDurationSeconds } from "../../lib/ffmpeg";
import { Button, StatusPill, errorMessage, type StatusState } from "../ui";
import {
  generateAssetFilename,
  newAssetId,
  relPathForAsset,
  type Asset,
} from "../../lib/workspace";

type Status = { state: StatusState; message?: string };

export function ExtractFrameTab({
  folderName,
  externalRef,
  inputVideo,
  inputVideoUrl,
  scrubSeconds,
  onScrubChange,
  onSave,
}: {
  folderName: string;
  externalRef: string;
  inputVideo: Asset | null;
  inputVideoUrl: string | null;
  /** `null` = not yet seeded (use mid-clip on first mount). 0 is a
   *  legitimate value (extracting the opening frame) — don't use it
   *  as a sentinel. */
  scrubSeconds: number | null;
  onScrubChange: (next: number) => void;
  onSave: (asset: Asset) => Promise<void>;
}) {
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [durationSec, setDurationSec] = useState<number | null>(null);
  const [savedFrameUrl, setSavedFrameUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Reset session state when input video changes.
  useEffect(() => {
    setStatus({ state: "idle" });
    setDurationSec(inputVideo?.durationSec ?? null);
    setSavedFrameUrl(null);
  }, [inputVideo?.id]);

  /** Render-time effective scrub position: persisted value if set,
   *  otherwise the mid-clip default. Slider edits go through
   *  `onScrubChange` which writes the persisted value. */
  const effectiveSeconds =
    scrubSeconds ?? (durationSec ? durationSec / 2 : 0);

  async function saveFrame() {
    if (!inputVideo) return;
    setStatus({ state: "running", message: "ffmpeg extracting…" });
    const id = newAssetId();
    const filename = generateAssetFilename({ id, kind: "image", hint: "frame" });
    const targetRel = relPathForAsset(folderName, externalRef, {
      id,
      kind: "image",
      filename,
    } as Asset);
    try {
      const inAbs = await absPath(
        relPathForAsset(folderName, externalRef, inputVideo),
      );
      const outAbs = await absPath(targetRel);
      await extractFrame({
        videoAbsPath: inAbs,
        timestampSeconds: effectiveSeconds,
        outputAbsPath: outAbs,
      });
      const newAsset: Asset = {
        id,
        kind: "image",
        filename,
        label: `Frame @ ${effectiveSeconds.toFixed(2)}s from ${inputVideo.label}`,
        parentAssetIds: [inputVideo.id],
        createdAt: Date.now(),
      };
      // Awaited persistence — see autosave-race note in App.tsx.
      await onSave(newAsset);
      setSavedFrameUrl(await asset(targetRel));
      setStatus({ state: "done", message: "saved to gallery" });
    } catch (e) {
      setStatus({ state: "error", message: errorMessage(e) });
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Extract frame</h2>
        <StatusPill state={status.state} message={status.message} />
      </header>

      {!inputVideo ? (
        <div className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-950 p-8 text-center text-sm text-neutral-500">
          Pick a video from the sidebar to scrub for a frame.
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
                // Some MP4s (notably Wan output before remux) lack a
                // moov atom hint, so `<video>` reports `Infinity` on
                // metadata. Fall back to ffprobe in that case so the
                // slider doesn't silently cap at the fallback max for
                // the rest of the session.
                if (!Number.isFinite(d) || d <= 0) {
                  if (inputVideo) {
                    try {
                      const abs = await absPath(
                        relPathForAsset(folderName, externalRef, inputVideo),
                      );
                      d = await probeDurationSeconds(abs);
                    } catch {
                      return;
                    }
                  } else {
                    return;
                  }
                }
                setDurationSec(d);
                // Seed only when the persisted value is null —
                // legitimate 0 (opening frame) must survive.
                const seeded = scrubSeconds ?? d / 2;
                const start = Math.max(0, Math.min(seeded, d - 0.05));
                if (scrubSeconds === null) onScrubChange(start);
                e.currentTarget.currentTime = start;
              }}
              className="w-full max-w-2xl rounded-lg border border-neutral-800"
            />
          )}

          <div className="mt-3 flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={durationSec ?? 5}
              step={1 / 60}
              value={effectiveSeconds}
              onChange={(e) => {
                const v = Number(e.currentTarget.value);
                onScrubChange(v);
                if (videoRef.current) {
                  videoRef.current.currentTime = v;
                }
              }}
              className="flex-1 accent-indigo-500"
            />
            <span className="w-28 text-right font-mono text-xs text-neutral-400">
              {effectiveSeconds.toFixed(2)} /{" "}
              {durationSec ? durationSec.toFixed(2) : "?"} s
            </span>
          </div>

          <div className="mt-4">
            <Button
              onClick={saveFrame}
              disabled={!durationSec || status.state === "running"}
            >
              {status.state === "running" ? "Extracting…" : "Save frame to assets"}
            </Button>
          </div>

          {savedFrameUrl && (
            <div className="mt-4">
              <p className="mb-1 text-xs text-neutral-500">Last saved frame:</p>
              <img
                src={savedFrameUrl}
                alt="extracted frame"
                className="max-h-64 rounded-lg border border-neutral-800"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
