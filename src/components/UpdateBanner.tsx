// Floating "update available" toast (bottom-right, VS Code style). Shown
// when the startup check finds a newer release. Non-blocking: the user
// can keep working, update now, or dismiss until next launch.

import { Button } from "./ui";
import { formatBytes, type DownloadProgress } from "../lib/updater";

export type UpdateBannerState = "available" | "downloading" | "error";

export function UpdateBanner({
  version,
  state,
  progress,
  error,
  onUpdate,
  onDismiss,
}: {
  version: string;
  state: UpdateBannerState;
  progress: DownloadProgress | null;
  error: string | null;
  onUpdate: () => void;
  onDismiss: () => void;
}) {
  const downloading = state === "downloading";
  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 rounded-xl border border-neutral-700 bg-neutral-900 p-4 shadow-2xl">
      <div className="mb-1 flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-neutral-100">
          Update available
        </h3>
        {!downloading && (
          <button
            onClick={onDismiss}
            title="Dismiss until next launch"
            className="-mt-1 rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            ×
          </button>
        )}
      </div>

      <p className="mb-3 text-xs text-neutral-400">
        Gaiare Studio{" "}
        <span className="font-medium text-neutral-200">v{version}</span> is
        ready. The app will restart to apply it — no reinstall needed.
      </p>

      {state === "error" && error && (
        <p className="mb-3 text-xs text-rose-300">⚠ {error}</p>
      )}

      {downloading ? (
        <div className="space-y-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full bg-indigo-500 transition-all"
              style={{ width: pct !== null ? `${pct}%` : "40%" }}
            />
          </div>
          <p className="text-[11px] text-neutral-500">
            {pct !== null && progress
              ? `Downloading… ${pct}% (${formatBytes(progress.downloaded)}${
                  progress.total ? ` / ${formatBytes(progress.total)}` : ""
                })`
              : "Downloading…"}
          </p>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onDismiss}>
            Later
          </Button>
          <Button onClick={onUpdate}>
            {state === "error" ? "Retry" : "Download & Restart"}
          </Button>
        </div>
      )}
    </div>
  );
}
