// Sidebar listing every asset in the workspace, split into "Image
// assets" and "Video assets" sections. The active tab's required kind
// is highlighted; the other section is dimmed and clicking switches the
// active tab to use the asset. Each card has a delete button (×) that
// removes the file from disk and the entry from the workspace.

import { useEffect, useRef } from "react";
import { clsx } from "clsx";
import { isLockedAsset, type Asset, type AssetKind } from "../lib/workspace";
import { DRAG_PAYLOAD_MIME, encodeDragPayload } from "../lib/drag";

export function AssetGallery({
  assets,
  selectedAssetId,
  onSelect,
  onRequestDelete,
  activeKind,
  onPickIncompatible,
  onPreview,
  taggedAssetIds,
  onToggleTag,
  onClearTags,
  thumbnailUrls,
}: {
  assets: Asset[];
  selectedAssetId: string | null;
  onSelect: (id: string) => void;
  /** Called when the user clicks × on an asset card. Caller is
   *  responsible for confirmation, file removal, and workspace update. */
  onRequestDelete: (id: string) => void;
  /** Which kind the active tab consumes — used for highlight + dimming. */
  activeKind: AssetKind;
  /** Called when the user clicks an asset whose kind doesn't match the
   *  active tab. Parent can switch tabs and select in one move. */
  onPickIncompatible: (id: string, kind: AssetKind) => void;
  /** Open the inspect viewer for this asset. Triggered by the 👁
   *  hover icon — gallery clicks still go to onSelect /
   *  onPickIncompatible as before. */
  onPreview: (id: string) => void;
  /** Ordered list of "tagged" asset IDs. Each tagged card renders its
   *  1-indexed position as a badge. Toggling is via the `T` hotkey
   *  while hovering a card. */
  taggedAssetIds: string[];
  onToggleTag: (id: string) => void;
  onClearTags: () => void;
  thumbnailUrls: Record<string, string>;
}) {
  const images = assets.filter((a) => a.kind === "image");
  const videos = assets.filter((a) => a.kind === "video");

  // Hover-tracked focused asset id. The `T` hotkey reads this ref to
  // know which card to tag/untag without forcing the user to click
  // first (clicking has other side effects — setting input asset,
  // opening new tab — which we don't want to trigger just for
  // tagging).
  const hoveredAssetIdRef = useRef<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "t" && e.key !== "T") return;
      // Ignore when typing in inputs / textareas / contenteditable —
      // the user is typing the letter T, not tagging.
      const t = e.target as Element | null;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t && (t as HTMLElement).isContentEditable)
      ) {
        return;
      }
      const id = hoveredAssetIdRef.current;
      if (!id) return;
      e.preventDefault();
      onToggleTag(id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onToggleTag]);

  // Map asset id → 1-indexed badge number. Lookup builds once per
  // render; gallery sizes are small (<50) so the cost is irrelevant.
  const tagPositionById = new Map<string, number>();
  taggedAssetIds.forEach((id, i) => tagPositionById.set(id, i + 1));

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
      <div className="border-b border-neutral-800 px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Assets
          </h2>
          {taggedAssetIds.length > 0 && (
            <button
              onClick={onClearTags}
              className="rounded-full bg-indigo-900/30 px-2 py-0.5 text-[10px] uppercase tracking-wider text-indigo-300 hover:bg-indigo-900/50"
              title="Clear all tags"
            >
              Clear tags ({taggedAssetIds.length})
            </button>
          )}
        </div>
        <p className="mt-1 text-[11px] text-neutral-600">
          Click to use as input · × to delete · hover + T to tag for
          Stitch
        </p>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-2">
        <Section
          title="Image assets"
          highlighted={activeKind === "image"}
          assets={images}
          selectedAssetId={selectedAssetId}
          onSelect={onSelect}
          onRequestDelete={onRequestDelete}
          onPickIncompatible={(id) => onPickIncompatible(id, "image")}
          onPreview={onPreview}
          activeKind={activeKind}
          thumbnailUrls={thumbnailUrls}
          tagPositionById={tagPositionById}
          hoveredAssetIdRef={hoveredAssetIdRef}
          empty="No images yet."
        />
        <Section
          title="Video assets"
          highlighted={activeKind === "video"}
          assets={videos}
          selectedAssetId={selectedAssetId}
          onSelect={onSelect}
          onRequestDelete={onRequestDelete}
          onPickIncompatible={(id) => onPickIncompatible(id, "video")}
          onPreview={onPreview}
          activeKind={activeKind}
          thumbnailUrls={thumbnailUrls}
          tagPositionById={tagPositionById}
          hoveredAssetIdRef={hoveredAssetIdRef}
          empty="No videos yet — generate one from the Generate Clip tab."
        />
      </div>
    </aside>
  );
}

function Section({
  title,
  highlighted,
  assets,
  selectedAssetId,
  onSelect,
  onRequestDelete,
  onPickIncompatible,
  onPreview,
  activeKind,
  thumbnailUrls,
  tagPositionById,
  hoveredAssetIdRef,
  empty,
}: {
  title: string;
  highlighted: boolean;
  assets: Asset[];
  selectedAssetId: string | null;
  onSelect: (id: string) => void;
  onRequestDelete: (id: string) => void;
  onPickIncompatible: (id: string) => void;
  onPreview: (id: string) => void;
  activeKind: AssetKind;
  thumbnailUrls: Record<string, string>;
  tagPositionById: Map<string, number>;
  hoveredAssetIdRef: React.MutableRefObject<string | null>;
  empty: string;
}) {
  return (
    <div
      className={clsx(
        "rounded-xl border transition-colors",
        highlighted
          ? "border-neutral-700 bg-neutral-950"
          : "border-transparent opacity-60",
      )}
    >
      <div className="px-3 py-2">
        <span
          className={clsx(
            "text-[10px] font-semibold uppercase tracking-wider",
            highlighted ? "text-neutral-300" : "text-neutral-600",
          )}
        >
          {title}
        </span>
      </div>
      {assets.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-neutral-600">{empty}</p>
      ) : (
        <ul className="space-y-1 px-2 pb-2">
          {assets.map((asset) => {
            const isCompatible = asset.kind === activeKind;
            const isSelected = selectedAssetId === asset.id;
            return (
              <li key={asset.id}>
                <AssetCard
                  asset={asset}
                  isSelected={isSelected}
                  isCompatible={isCompatible}
                  thumbnailUrl={thumbnailUrls[asset.id] ?? null}
                  tagPosition={tagPositionById.get(asset.id) ?? null}
                  hoveredAssetIdRef={hoveredAssetIdRef}
                  onClick={() =>
                    isCompatible
                      ? onSelect(asset.id)
                      : onPickIncompatible(asset.id)
                  }
                  onDelete={() => onRequestDelete(asset.id)}
                  onPreview={() => onPreview(asset.id)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AssetCard({
  asset,
  isSelected,
  isCompatible,
  thumbnailUrl,
  tagPosition,
  hoveredAssetIdRef,
  onClick,
  onDelete,
  onPreview,
}: {
  asset: Asset;
  isSelected: boolean;
  isCompatible: boolean;
  thumbnailUrl: string | null;
  /** 1-indexed badge number when this asset is tagged, null otherwise. */
  tagPosition: number | null;
  /** Set on hover so the global `T` hotkey knows which card to act on. */
  hoveredAssetIdRef: React.MutableRefObject<string | null>;
  onClick: () => void;
  onDelete: () => void;
  onPreview: () => void;
}) {
  // Only video assets are draggable today — the Stitch tab is the only
  // drop target and it consumes videos. Source images stay non-draggable
  // (they're a single-instance anchor, dragging them adds no value and
  // browsers paint a confusing drag image for protected items).
  const draggable = asset.kind === "video";

  // If the card unmounts while still hovered (asset deleted, workspace
  // switched, filter changed) `onMouseLeave` never fires — the ref
  // would keep the dead id and the next `T` press would tag a
  // non-existent asset. Belt-and-braces clear on unmount.
  useEffect(() => {
    return () => {
      if (hoveredAssetIdRef.current === asset.id) {
        hoveredAssetIdRef.current = null;
      }
    };
  }, [asset.id, hoveredAssetIdRef]);

  return (
    <div
      draggable={draggable}
      onMouseEnter={() => {
        hoveredAssetIdRef.current = asset.id;
      }}
      onMouseLeave={() => {
        if (hoveredAssetIdRef.current === asset.id) {
          hoveredAssetIdRef.current = null;
        }
      }}
      onDragStart={(e) => {
        if (!draggable) return;
        e.dataTransfer.setData(
          DRAG_PAYLOAD_MIME,
          encodeDragPayload({ source: "gallery", assetId: asset.id }),
        );
        e.dataTransfer.effectAllowed = "copy";
      }}
      className={clsx(
        "group relative flex items-center gap-3 rounded-lg p-2 transition-colors",
        isSelected
          ? "bg-indigo-900/40 ring-1 ring-indigo-500"
          : isCompatible
            ? "hover:bg-neutral-900"
            : "hover:bg-neutral-900/50",
        // Tagged cards get a subtle indigo ring so they're easy to find
        // at a glance even when not focused.
        tagPosition !== null && !isSelected && "ring-1 ring-indigo-700/60",
        draggable && "cursor-grab active:cursor-grabbing",
      )}
    >
      {/* Tag badge — top-left over the thumbnail. Indigo to match the
          ring + chat panel accents; bold so the number is the first
          thing your eye lands on. */}
      {tagPosition !== null && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-bold text-white shadow"
          title={`Tagged #${tagPosition} — press T while hovering to untag`}
        >
          {tagPosition}
        </span>
      )}
      <button
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        title={
          isCompatible
            ? `Use "${asset.label}" as input for the current tab`
            : asset.kind === "image"
              ? `"${asset.label}" is an image — current tab needs a video.\nClick to open a new Generate Clip tab with this image as the start frame.`
              : `"${asset.label}" is a video — current tab needs an image.\nClick to open a new Extract Frame tab on this video.`
        }
      >
        {/* Hover pill on incompatible cards — replaces the previously
            silent "click opens a new tab" side-effect with a visible
            cue. Hidden by default to avoid permanent visual noise. */}
        {!isCompatible && (
          <span
            aria-hidden
            className="pointer-events-none absolute right-2 top-2 hidden rounded-full bg-neutral-800 px-2 py-0.5 text-[9px] uppercase tracking-wider text-neutral-400 group-hover:block"
          >
            ↗ new {asset.kind === "image" ? "Generate" : "Extract"}
          </span>
        )}
        <div className="h-12 w-16 shrink-0 overflow-hidden rounded bg-neutral-900">
          {!thumbnailUrl ? (
            <div className="flex h-full w-full items-center justify-center text-[10px] text-neutral-600">
              {asset.kind === "image" ? "img" : "mp4"}
            </div>
          ) : asset.kind === "image" ? (
            <img
              src={thumbnailUrl}
              alt={asset.label}
              className="h-full w-full object-cover"
            />
          ) : (
            // <img> with an .mp4 src renders nothing. Use <video> +
            // seek-to-frame-0 trick so the gallery row shows the
            // opening frame instead of a black square.
            <video
              src={thumbnailUrl}
              muted
              preload="metadata"
              onLoadedMetadata={(e) => {
                e.currentTarget.currentTime = 0.1;
              }}
              className="h-full w-full object-cover"
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-neutral-200">{asset.label}</p>
          <p className="truncate text-[10px] text-neutral-500">
            {asset.kind === "video" && asset.durationSec
              ? `${asset.durationSec.toFixed(1)}s · `
              : ""}
            {new Date(asset.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-0.5">
        {/* 👁 inspect — hidden until hover. Inspect mode shows
            metadata + actions with explicit labels, useful for
            confirming what generation produced a clip before reusing
            it. Click-to-pick on the card itself stays the fast path. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPreview();
          }}
          title="Open in viewer"
          className="invisible flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 group-hover:visible"
        >
          👁
        </button>
        {isLockedAsset(asset) ? (
          <span
            title={
              asset.role === "source"
                ? "Source image (protected)"
                : "Canonical image from Rails (locked)"
            }
            className="flex h-6 w-6 items-center justify-center rounded text-[10px] text-neutral-600"
          >
            🔒
          </span>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete asset"
            className="invisible flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-rose-900/40 hover:text-rose-300 group-hover:visible"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
