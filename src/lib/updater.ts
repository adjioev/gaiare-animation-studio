// In-app auto-update — thin wrapper over the Tauri updater + process
// plugins. The updater checks the GitHub Releases `latest.json` feed
// (configured in src-tauri/tauri.conf.json), verifies the bundle against
// the embedded public key, installs it in place, and relaunches — so a
// new version no longer means a full reinstall.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type { Update };

export type DownloadProgress = {
  downloaded: number;
  /** Total bytes, or null until the server reports Content-Length. */
  total: number | null;
};

/**
 * Check the release feed for a newer version. Returns the pending
 * `Update` (pass it to `downloadAndApply`) or `null` when already current.
 *
 * In `pnpm tauri dev` there is no installed bundle or update feed, so the
 * plugin throws. We treat that as "no update" rather than surfacing a
 * confusing error while developing.
 */
export async function checkForUpdate(): Promise<Update | null> {
  try {
    return await check();
  } catch (e) {
    if (import.meta.env.DEV) {
      console.info("[updater] check skipped (dev / no feed):", e);
      return null;
    }
    throw e;
  }
}

/**
 * Download the update (reporting byte progress) and install it, then
 * relaunch into the new version. On success the app restarts, so this
 * call does not return.
 */
export async function downloadAndApply(
  update: Update,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        break;
      case "Finished":
        break;
    }
    onProgress?.({ downloaded, total });
  });
  await relaunch();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
