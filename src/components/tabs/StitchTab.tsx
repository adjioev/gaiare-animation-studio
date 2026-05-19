// Stitch tab — concatenates 2+ video assets into a single output. The
// list is presented as a horizontal filmstrip (iMovie / CapCut idiom);
// drag-and-drop both from the gallery (add) and within the strip
// (reorder) is the primary input method, with click-in-gallery also
// appending for keyboard / touch-trackpad parity.

import { useEffect, useState } from "react";
import { BaseDirectory, exists } from "@tauri-apps/plugin-fs";
import { absPath, asset } from "../../lib/workdir";
import { stitchClips } from "../../lib/ffmpeg";
import { Button, StatusPill, errorMessage, type StatusState } from "../ui";
import {
  findAsset,
  generateAssetFilename,
  newAssetId,
  relPathForAsset,
  type Asset,
  type Workspace,
} from "../../lib/workspace";
import {
  DRAG_PAYLOAD_MIME,
  encodeDragPayload,
  readDragPayload,
} from "../../lib/drag";

type Status = { state: StatusState; message?: string };

const SOFT_CLIP_LIMIT = 20;

export function StitchTab({
  folderName,
  externalRef,
  workspace,
  inputAssetIds,
  thumbnailUrls,
  onChange,
  onSave,
  taggedAssetIds,
  onAppendTagged,
}: {
  folderName: string;
  externalRef: string;
  /** The full workspace lets us resolve assetIds to label + duration
   *  without threading another prop. */
  workspace: Workspace;
  inputAssetIds: string[];
  thumbnailUrls: Record<string, string>;
  onChange: (next: string[]) => void;
  onSave: (asset: Asset) => Promise<void>;
  /** Ordered list of asset IDs the contractor pre-tagged in the
   *  gallery. The "Append tagged" button below adds them in order. */
  taggedAssetIds: string[];
  onAppendTagged: () => void;
}) {
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [savedClipUrl, setSavedClipUrl] = useState<string | null>(null);
  /** Visual feedback while a drag is hovering the strip. */
  const [dropHighlight, setDropHighlight] = useState(false);

  useEffect(() => {
    setStatus({ state: "idle" });
    setSavedClipUrl(null);
  }, [externalRef]);

  // Resolve each slot to an Asset. Missing assets render as a "missing"
  // placeholder card so the user can remove the slot without crashing.
  const slots = inputAssetIds.map((id) => ({
    id,
    asset: findAsset(workspace, id),
  }));

  const validSlots = slots.filter((s) => s.asset !== null);
  const totalDuration = validSlots.reduce(
    (sum, s) => sum + (s.asset?.durationSec ?? 0),
    0,
  );

  // ─── List ops ───────────────────────────────────────────────────
  function removeAt(index: number) {
    onChange(inputAssetIds.filter((_, i) => i !== index));
  }

  function moveSlot(from: number, to: number) {
    if (from === to) return;
    const next = [...inputAssetIds];
    const [moved] = next.splice(from, 1);
    if (moved !== undefined) {
      // Adjust `to` when moving forward, because removing the source
      // shifts everything past it left by one.
      const adjusted = from < to ? to - 1 : to;
      next.splice(adjusted, 0, moved);
    }
    onChange(next);
  }

  // ─── D&D ────────────────────────────────────────────────────────
  function onStripDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(DRAG_PAYLOAD_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropHighlight(true);
  }

  function onStripDragLeave(e: React.DragEvent<HTMLDivElement>) {
    // dragleave fires when the cursor enters ANY descendant (slot
    // cards, the trailing +). Without the relatedTarget check the
    // highlight clears every time the cursor moves between cards,
    // then the card's onDragOver re-sets it → strobe-light effect.
    // Only treat as "actually left" if the new target isn't inside
    // the strip container.
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setDropHighlight(false);
  }

  function onStripDrop(e: React.DragEvent, dropIndex: number) {
    setDropHighlight(false);
    const payload = readDragPayload(e.dataTransfer);
    if (!payload) return;
    e.preventDefault();
    if (payload.source === "gallery") {
      // Append from gallery — drop index is treated as "insert here".
      const next = [...inputAssetIds];
      next.splice(dropIndex, 0, payload.assetId);
      onChange(next);
    } else {
      moveSlot(payload.index, dropIndex);
    }
  }

  function onSlotDragStart(e: React.DragEvent, index: number) {
    e.dataTransfer.setData(
      DRAG_PAYLOAD_MIME,
      encodeDragPayload({ source: "strip", index }),
    );
    e.dataTransfer.effectAllowed = "move";
  }

  // ─── Save ──────────────────────────────────────────────────────
  async function save() {
    if (inputAssetIds.length < 2) return;
    setStatus({ state: "running", message: "checking inputs…" });

    // Pre-flight: every input must be a video AND exist on disk.
    // Surface a clear error listing missing clips rather than relying
    // on ffmpeg's stderr to explain.
    const missing: string[] = [];
    const inputAbsPaths: string[] = [];
    for (const id of inputAssetIds) {
      const a = findAsset(workspace, id);
      if (!a) {
        missing.push(`<deleted ${id.slice(0, 6)}>`);
        continue;
      }
      const rel = relPathForAsset(folderName, externalRef, a);
      if (!(await exists(rel, { baseDir: BaseDirectory.Document }))) {
        missing.push(a.label);
        continue;
      }
      inputAbsPaths.push(await absPath(rel));
    }
    if (missing.length > 0) {
      setStatus({
        state: "error",
        message: `Missing clip(s): ${missing.join(", ")}. Remove and try again.`,
      });
      return;
    }

    setStatus({ state: "running", message: "ffmpeg stitching…" });

    const id = newAssetId();
    const filename = generateAssetFilename({ id, kind: "video", hint: "stitched" });
    const targetRel = relPathForAsset(folderName, externalRef, {
      id,
      kind: "video",
      filename,
    } as Asset);

    try {
      const outAbs = await absPath(targetRel);
      await stitchClips({ inputAbsPaths, outputAbsPath: outAbs });
      const labels = validSlots
        .map((s) => s.asset!.label)
        .slice(0, 3)
        .join(" + ");
      const labelTail =
        validSlots.length > 3 ? ` + ${validSlots.length - 3} more` : "";
      const newAsset: Asset = {
        id,
        kind: "video",
        filename,
        label: `Stitch of ${validSlots.length} clips · ${labels}${labelTail}`,
        // Keep duplicates so the genealogy shows "this clip appears N
        // times in the source sequence" rather than collapsing to a set.
        parentAssetIds: [...inputAssetIds],
        durationSec: totalDuration,
        createdAt: Date.now(),
      };
      await onSave(newAsset);
      setSavedClipUrl(`${await asset(targetRel)}?t=${Date.now()}`);
      setStatus({
        state: "done",
        message: `stitched ${validSlots.length} clips`,
      });
    } catch (e) {
      setStatus({ state: "error", message: errorMessage(e) });
    }
  }

  const canSave = inputAssetIds.length >= 2 && status.state !== "running";

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Stitch clips</h2>
        <StatusPill state={status.state} message={status.message} />
      </header>

      <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-xs uppercase tracking-wide text-neutral-500">
            Sequence · drag clips from the gallery to add, drag within the
            strip to reorder
          </p>
          {/* Bulk-append from pre-tagged clips. Only video tags count
              for stitch (image tags are visible in the gallery but
              skipped here — filtering happens in App.tsx). */}
          {(() => {
            const taggedVideos = taggedAssetIds.filter((id) => {
              const a = workspace.assets.find((x) => x.id === id);
              return a?.kind === "video";
            });
            if (taggedVideos.length === 0) return null;
            return (
              <button
                onClick={onAppendTagged}
                className="shrink-0 rounded-full bg-indigo-600 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-white hover:bg-indigo-500"
                title="Append all tagged clips to the end of the sequence (in order), then clear the tags"
              >
                Append {taggedVideos.length} tagged ↘
              </button>
            );
          })()}
        </div>

        {/* Filmstrip — horizontal scroll. The trailing drop zone at
            `index = length` lets the user append by dropping after the
            last card. */}
        <div
          onDragLeave={onStripDragLeave}
          className={
            "flex min-h-32 items-stretch gap-2 overflow-x-auto rounded-lg border-2 border-dashed p-3 transition-colors " +
            (dropHighlight
              ? "border-indigo-500 bg-indigo-950/20"
              : "border-neutral-800 bg-neutral-900/40")
          }
        >
          {inputAssetIds.length === 0 ? (
            <div
              onDragOver={onStripDragOver}
              onDrop={(e) => onStripDrop(e, 0)}
              className="flex flex-1 items-center justify-center text-sm text-neutral-500"
            >
              Drop videos here from the gallery
            </div>
          ) : (
            <>
              {slots.map((slot, index) => (
                <SlotCard
                  key={`${slot.id}-${index}`}
                  index={index}
                  asset={slot.asset}
                  thumbnailUrl={
                    slot.asset ? thumbnailUrls[slot.asset.id] ?? null : null
                  }
                  onRemove={() => removeAt(index)}
                  onDragStart={onSlotDragStart}
                  onDragOver={onStripDragOver}
                  onDrop={(e) => onStripDrop(e, index)}
                />
              ))}
              {/* Trailing drop zone — append after the last card. */}
              <div
                onDragOver={onStripDragOver}
                onDrop={(e) => onStripDrop(e, inputAssetIds.length)}
                className="flex w-12 shrink-0 items-center justify-center rounded-lg border border-dashed border-neutral-800 text-2xl text-neutral-700"
                title="Drop here to append to the sequence"
              >
                +
              </div>
            </>
          )}
        </div>

        <div className="mt-3 flex items-center justify-between text-xs text-neutral-500">
          <span>
            {inputAssetIds.length === 0
              ? "Empty — add at least 2 clips to stitch"
              : `${inputAssetIds.length} clip${inputAssetIds.length === 1 ? "" : "s"} · total ${totalDuration.toFixed(1)}s`}
          </span>
          {inputAssetIds.length >= SOFT_CLIP_LIMIT && (
            <span className="text-amber-300">
              ⚠ {inputAssetIds.length} clips — ffmpeg may take a minute+
            </span>
          )}
        </div>

        <div className="mt-6 flex items-center gap-3">
          <Button onClick={save} disabled={!canSave}>
            {status.state === "running"
              ? status.message ?? "Working…"
              : "Save stitched clip to assets"}
          </Button>
          {inputAssetIds.length === 1 && (
            <span className="text-xs text-neutral-500">
              Add at least one more clip to enable stitching.
            </span>
          )}
        </div>

        {savedClipUrl && (
          <div className="mt-4">
            <p className="mb-1 text-xs text-neutral-500">Last stitched clip:</p>
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

      <p className="text-xs text-neutral-500">
        Output is re-encoded at 16 fps with libx264 so concat artefacts
        (variable framerate, GOP mismatch) don't surface. Duplicates in
        the sequence are kept — handy for repeating a clip without
        re-running Wan.
      </p>
    </div>
  );
}

function SlotCard({
  index,
  asset,
  thumbnailUrl,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  index: number;
  asset: Asset | null;
  thumbnailUrl: string | null;
  onRemove: () => void;
  onDragStart: (e: React.DragEvent, index: number) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  if (!asset) {
    return (
      <div
        onDragOver={onDragOver}
        onDrop={onDrop}
        className="flex w-56 shrink-0 flex-col items-center justify-center gap-2 rounded-lg border border-rose-900/40 bg-rose-950/20 p-2 text-center text-[11px] text-rose-300"
      >
        <span>missing clip</span>
        <button
          onClick={onRemove}
          className="rounded bg-rose-900/40 px-2 py-0.5 text-[10px] text-rose-200 hover:bg-rose-900/60"
        >
          Remove slot
        </button>
      </div>
    );
  }
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, index)}
      onDragOver={onDragOver}
      onDrop={onDrop}
      // w-56 / h-32 = 224×128 ≈ 16:9, matching Wan's 480p output
      // aspect so the thumbnail isn't letterboxed.
      className="group relative flex w-56 shrink-0 cursor-grab flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900 p-2 active:cursor-grabbing"
      title={`${asset.label} · drag to reorder`}
    >
      <div className="h-32 w-full overflow-hidden rounded bg-neutral-950">
        {thumbnailUrl ? (
          <video
            src={thumbnailUrl}
            muted
            preload="metadata"
            // `preload="metadata"` loads duration/dimensions but doesn't
            // paint a frame. Seeking to ~0.1s forces the browser to
            // decode the opening frame so the slot has a real preview.
            onLoadedMetadata={(e) => {
              e.currentTarget.currentTime = 0.1;
            }}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] text-neutral-600">
            mp4
          </div>
        )}
      </div>
      <div className="flex items-center justify-between">
        <p className="min-w-0 truncate text-[11px] text-neutral-300">
          {asset.label}
        </p>
        <button
          onClick={onRemove}
          className="ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] text-neutral-600 opacity-0 transition-opacity hover:bg-rose-900/40 hover:text-rose-300 group-hover:opacity-100"
          title="Remove from sequence"
        >
          ×
        </button>
      </div>
      <p className="text-[10px] text-neutral-500">
        #{index + 1} · {asset.durationSec?.toFixed(1) ?? "?"}s
      </p>
    </div>
  );
}
