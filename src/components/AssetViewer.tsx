// Asset viewer modal — opens via the 👁 icon on a gallery card. Shows
// the asset at full size, surfaces metadata the gallery card can't fit
// (full creation timestamp, generation prompt for Wan clips, parent
// asset references), and exposes the same actions the gallery click
// would do but with explicit labels — no more silent "click opens a
// new tab" surprises.
//
// Click-to-pick on the gallery remains the fast path; this modal is
// inspect mode for when you want to see the clip large or check what
// prompt produced it.

import { useEffect, useRef, useState } from "react";
import { Button } from "./ui";
import type { Asset, PersistedTab, Workspace } from "../lib/workspace";

type ActiveTabKind = PersistedTab["kind"] | null;

export function AssetViewer({
  asset,
  thumbnailUrl,
  workspace,
  thumbnailUrls,
  activeTabKind,
  onClose,
  onUseAsInput,
  onOpenInNewTab,
}: {
  asset: Asset;
  thumbnailUrl: string | null;
  /** Read-only — used to render parent labels in the genealogy line.
   *  Not passed to the actions (those run via callbacks above). */
  workspace: Workspace;
  /** Full map so the Compare toggle can resolve the parent's
   *  thumbnail without another round-trip. */
  thumbnailUrls: Record<string, string>;
  /** `null` if no tab is open. Used to enable/disable the "use as
   *  input" action and to label what tab kind would be opened by
   *  the secondary action. */
  activeTabKind: ActiveTabKind;
  onClose: () => void;
  /** Use this asset as input for the currently-active tab. Caller
   *  decides what that means per tab kind (replace for single-input
   *  tabs, append for stitch). */
  onUseAsInput: () => void;
  /** Open a fresh tab whose kind is the natural fit for this asset's
   *  kind (image → Generate, video → Extract). The button label
   *  reflects that. */
  onOpenInNewTab: () => void;
}) {
  const useBtnRef = useRef<HTMLButtonElement | null>(null);

  // Esc to close, focus the primary action so keyboard users can
  // commit immediately. Matches ConfirmModal pattern.
  //
  // `stopPropagation` on Esc prevents the keydown bubbling to other
  // window-scoped listeners — without it, a confirm modal stacked
  // over the viewer would also dismiss on the same press.
  useEffect(() => {
    useBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isProtected = asset.role === "source";
  const naturalTabKind: ActiveTabKind =
    asset.kind === "image" ? "generate" : "extract";
  const newTabLabel =
    naturalTabKind === "generate"
      ? "Open in new Generate Clip tab"
      : "Open in new Extract Frame tab";

  // "Use as input" is enabled when the active tab's input slot
  // accepts this asset's kind. Exhaustive switch — when a new tab
  // kind lands (e.g. narration) TypeScript will fail at the
  // `never` assignment instead of silently routing to a wrong
  // default branch.
  const useAsInputEnabled = (() => {
    if (!activeTabKind) return false;
    switch (activeTabKind) {
      case "generate":
      case "transform":
        return asset.kind === "image";
      case "extract":
      case "trim":
      case "stitch":
        return asset.kind === "video";
      default: {
        // Exhaustiveness sentinel — TypeScript fails here if a new
        // tab kind is added without updating the switch above.
        const exhaustive: never = activeTabKind;
        return exhaustive;
      }
    }
  })();
  const useAsInputLabel =
    activeTabKind === "stitch"
      ? "Add to active Stitch sequence"
      : "Use as input in active tab";

  // Parent assets — show labels for context ("frame extracted from
  // <clip>", "trim of <clip>") so the user can navigate their work
  // back up the genealogy chain.
  const parentLabels = (asset.parentAssetIds ?? [])
    .map((id) => workspace.assets.find((a) => a.id === id)?.label)
    .filter((l): l is string => Boolean(l));

  // First image parent for the Compare toggle — only meaningful for
  // image assets with an image parent (Transform results pointing at
  // a source image). Other lineage cases (video → frame, clip → trim)
  // wouldn't be useful side-by-side at this size.
  const firstImageParent = (asset.parentAssetIds ?? [])
    .map((id) => workspace.assets.find((a) => a.id === id))
    .find(
      (a): a is Asset => a !== undefined && a.kind === "image",
    );
  const compareThumbnailUrl =
    firstImageParent && asset.kind === "image"
      ? thumbnailUrls[firstImageParent.id] ?? null
      : null;
  const [compareMode, setCompareMode] = useState(false);
  // Reset compare when switching to a different asset in the same
  // viewer instance.
  useEffect(() => {
    setCompareMode(false);
  }, [asset.id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/80 pt-12"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl rounded-2xl border border-neutral-800 bg-neutral-950 p-6 shadow-2xl"
      >
        <header className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-neutral-800 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
                {asset.kind === "image" ? "🖼 image" : "🎞 video"}
              </span>
              {isProtected && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-900/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-300">
                  🔒 protected
                </span>
              )}
            </div>
            <h2 className="break-words text-base font-semibold text-neutral-100">
              {asset.label}
            </h2>
          </div>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="rounded p-1 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
          >
            ×
          </button>
        </header>

        {/* Preview — large rendering of the asset itself. Video uses
            controls so the contractor can scrub through the clip. In
            compare mode (image assets only, with an image parent),
            shows source-vs-result side-by-side so the contractor can
            verify the edit didn't break something. */}
        {compareThumbnailUrl && (
          <div className="mb-2 flex items-center justify-end gap-2">
            <button
              onClick={() => setCompareMode((v) => !v)}
              className={
                compareMode
                  ? "rounded-full bg-indigo-600 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-white hover:bg-indigo-500"
                  : "rounded-full border border-neutral-800 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-neutral-300 hover:border-neutral-600 hover:text-white"
              }
              title="Show this asset side-by-side with its original (the parent it was derived from)"
            >
              {compareMode ? "Single view" : "Compare with original"}
            </button>
          </div>
        )}
        <div className="mb-4 overflow-hidden rounded-lg border border-neutral-800 bg-black">
          {!thumbnailUrl ? (
            <div className="flex h-48 items-center justify-center text-xs text-neutral-600">
              Preview unavailable
            </div>
          ) : compareMode && compareThumbnailUrl ? (
            <div className="grid grid-cols-2 gap-1 bg-neutral-900">
              <figure className="flex flex-col">
                <img
                  src={compareThumbnailUrl}
                  alt={firstImageParent?.label ?? "original"}
                  className="mx-auto max-h-[60vh] w-auto"
                />
                <figcaption className="bg-neutral-900 p-1 text-center text-[10px] uppercase tracking-wider text-neutral-500">
                  Original · {firstImageParent?.label ?? "?"}
                </figcaption>
              </figure>
              <figure className="flex flex-col">
                <img
                  src={thumbnailUrl}
                  alt={asset.label}
                  className="mx-auto max-h-[60vh] w-auto"
                />
                <figcaption className="bg-indigo-950/40 p-1 text-center text-[10px] uppercase tracking-wider text-indigo-300">
                  This asset
                </figcaption>
              </figure>
            </div>
          ) : asset.kind === "image" ? (
            <img
              src={thumbnailUrl}
              alt={asset.label}
              className="mx-auto max-h-[60vh] w-auto"
            />
          ) : (
            <video
              src={thumbnailUrl}
              controls
              muted
              playsInline
              className="mx-auto max-h-[60vh] w-auto"
            />
          )}
        </div>

        {/* Metadata block — concise table, only fields the architect
            review flagged as worth showing. Skip filename / file size /
            internal id — those belong in a separate debug surface. */}
        <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-neutral-500">Created</dt>
          <dd className="text-neutral-300">
            {new Date(asset.createdAt).toLocaleString()}
          </dd>
          {asset.kind === "video" && asset.durationSec !== undefined && (
            <>
              <dt className="text-neutral-500">Duration</dt>
              <dd className="text-neutral-300">
                {asset.durationSec.toFixed(2)} s
              </dd>
            </>
          )}
          {parentLabels.length > 0 && (
            <>
              <dt className="text-neutral-500">Derived from</dt>
              <dd className="text-neutral-300">{parentLabels.join(" · ")}</dd>
            </>
          )}
          {asset.prompt && (
            <>
              <dt className="text-neutral-500">Prompt</dt>
              <dd>
                <pre className="whitespace-pre-wrap break-words rounded border border-neutral-800 bg-neutral-900 p-2 font-mono text-[11px] text-neutral-300">
                  {asset.prompt}
                </pre>
              </dd>
            </>
          )}
        </dl>

        {isProtected && (
          <p className="mb-4 rounded-lg border border-amber-900/40 bg-amber-950/20 p-3 text-xs text-amber-200">
            Source image — the workspace anchor. It can't be deleted
            (delete it via "New workspace" instead, which starts fresh
            from a different source URL).
          </p>
        )}

        <footer className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenInNewTab();
              onClose();
            }}
          >
            {newTabLabel}
          </Button>
          <button
            ref={useBtnRef}
            onClick={() => {
              onUseAsInput();
              onClose();
            }}
            disabled={!useAsInputEnabled}
            title={
              useAsInputEnabled
                ? useAsInputLabel
                : activeTabKind
                  ? `Active tab doesn't accept ${asset.kind} input`
                  : "No tab is open"
            }
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {useAsInputLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
