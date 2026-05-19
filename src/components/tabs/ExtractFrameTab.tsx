// Extract-frame tab — picks a video asset, scrubs through it with a
// native `<video>` element (no ffmpeg until commit), and writes the
// chosen frame to disk as a new image asset on Save.

import { useEffect, useRef, useState } from "react";
import { absPath, asset } from "../../lib/workdir";
import { extractFrame } from "../../lib/ffmpeg";
import {
  Button,
  StatusPill,
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

export function ExtractFrameTab({
  externalRef,
  selectedVideo,
  selectedVideoUrl,
  onSave,
}: {
  externalRef: string;
  selectedVideo: Asset | null;
  /** `asset://` URL of the selected video — what the scrubbing `<video>`
   *  element loads. */
  selectedVideoUrl: string | null;
  onSave: (asset: Asset) => Promise<void>;
}) {
  const [status, setStatus] = useState<Status>(IDLE);
  const [seconds, setSeconds] = useState(0);
  const [durationSec, setDurationSec] = useState<number | null>(null);
  const [savedFrameUrl, setSavedFrameUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Reset when video changes
  useEffect(() => {
    setStatus(IDLE);
    setSeconds(selectedVideo?.durationSec ? selectedVideo.durationSec / 2 : 0);
    setDurationSec(selectedVideo?.durationSec ?? null);
    setSavedFrameUrl(null);
  }, [selectedVideo?.id]);

  async function saveFrame() {
    if (!selectedVideo) return;
    setStatus({ state: "running", message: "ffmpeg extracting…" });
    const id = newAssetId();
    const filename = generateAssetFilename({ id, kind: "image", hint: "frame" });
    const targetRel = relPathForAsset(externalRef, {
      id,
      kind: "image",
      filename,
    } as Asset);
    try {
      const inAbs = await absPath(
        relPathForAsset(externalRef, selectedVideo),
      );
      const outAbs = await absPath(targetRel);
      await extractFrame({
        videoAbsPath: inAbs,
        timestampSeconds: seconds,
        outputAbsPath: outAbs,
      });
      const newAsset: Asset = {
        id,
        kind: "image",
        filename,
        label: `Frame @ ${seconds.toFixed(2)}s from ${selectedVideo.label}`,
        parentAssetIds: [selectedVideo.id],
        createdAt: Date.now(),
      };
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

      {!selectedVideo ? (
        <div className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-950 p-8 text-center text-sm text-neutral-500">
          Pick a video from the sidebar to scrub for a frame.
        </div>
      ) : (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-6">
          <p className="mb-3 text-xs uppercase tracking-wide text-neutral-500">
            Source video · {selectedVideo.label}
          </p>

          {selectedVideoUrl && (
            <video
              ref={videoRef}
              src={selectedVideoUrl}
              preload="auto"
              muted
              playsInline
              onLoadedMetadata={(e) => {
                const d = e.currentTarget.duration;
                if (Number.isFinite(d) && d > 0) {
                  setDurationSec(d);
                  const start = Math.max(
                    0,
                    Math.min(seconds || d / 2, d - 0.05),
                  );
                  setSeconds(start);
                  e.currentTarget.currentTime = start;
                }
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
              value={seconds}
              onChange={(e) => {
                const v = Number(e.currentTarget.value);
                setSeconds(v);
                if (videoRef.current) {
                  videoRef.current.currentTime = v;
                }
              }}
              className="flex-1 accent-indigo-500"
            />
            <span className="w-28 text-right font-mono text-xs text-neutral-400">
              {seconds.toFixed(2)} / {durationSec ? durationSec.toFixed(2) : "?"} s
            </span>
          </div>

          <div className="mt-4">
            <Button onClick={saveFrame} disabled={!durationSec}>
              Save frame to assets
            </Button>
          </div>

          {savedFrameUrl && (
            <div className="mt-4">
              <p className="mb-1 text-xs text-neutral-500">
                Last saved frame:
              </p>
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
