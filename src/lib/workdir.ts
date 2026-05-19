// Local working directory: every question gets a subfolder where raw
// clips, mid-frames, stitched videos, and narration audio live until
// the contractor approves the final cut and we publish to S3.
//
// Path: ~/Documents/gaiare-animation-studio/q{externalRef}/
//   ├─ source.jpg              (downloaded from CDN)
//   ├─ clip1_v1.mp4 / clip1.mp4 (latest)
//   ├─ mid_frame.jpg
//   ├─ clip2.mp4
//   ├─ stitched-silent.mp4
//   ├─ narration_en.mp3
//   └─ final_en.mp4

import {
  BaseDirectory,
  exists,
  mkdir,
  writeFile,
  remove,
} from "@tauri-apps/plugin-fs";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const ROOT = "gaiare-animation-studio";

export function qdir(externalRef: string): string {
  return `${ROOT}/q${externalRef}`;
}

/**
 * Ensure the working directory for a question exists.
 */
export async function ensureWorkdir(externalRef: string): Promise<void> {
  const dir = qdir(externalRef);
  if (!(await exists(dir, { baseDir: BaseDirectory.Document }))) {
    await mkdir(dir, { baseDir: BaseDirectory.Document, recursive: true });
  }
}

/**
 * Download a remote URL and write it to the question's working dir
 * under `filename`. Returns the relative path inside `Document`
 * (callers compose with `BaseDirectory.Document` for subsequent fs ops).
 */
export async function downloadInto(args: {
  externalRef: string;
  filename: string;
  url: string;
}): Promise<string> {
  await ensureWorkdir(args.externalRef);
  const res = await tauriFetch(args.url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${args.url}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const relPath = `${qdir(args.externalRef)}/${args.filename}`;
  await writeFile(relPath, bytes, { baseDir: BaseDirectory.Document });
  return relPath;
}

export async function removeFile(relPath: string): Promise<void> {
  if (await exists(relPath, { baseDir: BaseDirectory.Document })) {
    await remove(relPath, { baseDir: BaseDirectory.Document });
  }
}

/**
 * Resolve a relative-to-Documents path to a `convertFileSrc` URL the
 * webview can render in an `<img>` / `<video>` tag without copying
 * bytes through JS. Appends a cache-bust query param so re-running
 * a step that overwrites the same file (e.g. re-extracting a mid-frame
 * to `mid_frame.jpg`) actually refreshes the preview — without it the
 * webview happily serves the previous bytes from cache.
 */
import { homeDir } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";

export async function asset(relPath: string): Promise<string> {
  // BaseDirectory.Document = ~/Documents on macOS; compose absolute path.
  const home = await homeDir();
  // Tauri 2 normalises separators; `homeDir` returns no trailing slash.
  const abs = `${home}/Documents/${relPath}`;
  const url = convertFileSrc(abs);
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${Date.now()}`;
}

/**
 * Absolute filesystem path for shell commands (ffmpeg etc.) — relative
 * paths inside Documents are convenient for fs plugin, but ffmpeg needs
 * a real path on disk.
 */
export async function absPath(relPath: string): Promise<string> {
  const home = await homeDir();
  return `${home}/Documents/${relPath}`;
}
