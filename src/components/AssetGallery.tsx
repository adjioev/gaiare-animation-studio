// Sidebar listing every asset in the workspace, split into "Image
// assets" and "Video assets" sections. The active tab's required kind
// is highlighted; the other section is dimmed and clicking switches the
// active tab to use the asset. Each card has a delete button (×) that
// removes the file from disk and the entry from the workspace.

import { clsx } from "clsx";
import type { Asset, AssetKind } from "../lib/workspace";

export function AssetGallery({
  assets,
  selectedAssetId,
  onSelect,
  onRequestDelete,
  activeKind,
  onPickIncompatible,
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
  thumbnailUrls: Record<string, string>;
}) {
  const images = assets.filter((a) => a.kind === "image");
  const videos = assets.filter((a) => a.kind === "video");

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
      <div className="border-b border-neutral-800 px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Assets
        </h2>
        <p className="mt-1 text-[11px] text-neutral-600">
          Click to use as input · × to delete
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
          activeKind={activeKind}
          thumbnailUrls={thumbnailUrls}
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
          activeKind={activeKind}
          thumbnailUrls={thumbnailUrls}
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
  activeKind,
  thumbnailUrls,
  empty,
}: {
  title: string;
  highlighted: boolean;
  assets: Asset[];
  selectedAssetId: string | null;
  onSelect: (id: string) => void;
  onRequestDelete: (id: string) => void;
  onPickIncompatible: (id: string) => void;
  activeKind: AssetKind;
  thumbnailUrls: Record<string, string>;
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
                  onClick={() =>
                    isCompatible
                      ? onSelect(asset.id)
                      : onPickIncompatible(asset.id)
                  }
                  onDelete={() => onRequestDelete(asset.id)}
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
  onClick,
  onDelete,
}: {
  asset: Asset;
  isSelected: boolean;
  isCompatible: boolean;
  thumbnailUrl: string | null;
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={clsx(
        "group relative flex items-center gap-3 rounded-lg p-2 transition-colors",
        isSelected
          ? "bg-indigo-900/40 ring-1 ring-indigo-500"
          : isCompatible
            ? "hover:bg-neutral-900"
            : "hover:bg-neutral-900/50",
      )}
    >
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
        <div className="h-12 w-16 shrink-0 overflow-hidden rounded bg-neutral-900">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={asset.label}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[10px] text-neutral-600">
              {asset.kind === "image" ? "img" : "mp4"}
            </div>
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

      {asset.role === "source" ? (
        <span
          title="Source image (protected)"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[10px] text-neutral-600"
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
          className="invisible flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-rose-900/40 hover:text-rose-300 group-hover:visible"
        >
          ×
        </button>
      )}
    </div>
  );
}
