// Local working directory: every question gets a subfolder under the
// configured workspace folder. The folder name is configurable via
// settings (see `lib/settings.ts`); the parent is always the user's
// Documents directory (cross-platform via Tauri's BaseDirectory).
//
// Path: <Documents>/<folderName>/q<externalRef>/
//   ├─ source-<id>.jpg
//   ├─ preview-<tabId>.mp4
//   ├─ clip-<id>.mp4
//   ├─ frame-<id>.jpg
//   └─ workspace.json
//
// Absolute paths used to be built with string concatenation
// (`${home}/Documents/${rel}`), which on Windows produced mixed
// separators (`C:\Users\...\/Documents/`). All absolute-path
// construction now goes through Tauri's `path.join()` API which
// uses native separators.

import {
  BaseDirectory,
  exists,
  mkdir,
  writeFile,
} from "@tauri-apps/plugin-fs";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { documentDir, join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";

/** Relative-to-Documents path of a question's working directory. */
export function qdir(folderName: string, externalRef: string): string {
  return `${folderName}/q${externalRef}`;
}

export async function ensureWorkdir(
  folderName: string,
  externalRef: string,
): Promise<void> {
  const dir = qdir(folderName, externalRef);
  if (!(await exists(dir, { baseDir: BaseDirectory.Document }))) {
    await mkdir(dir, { baseDir: BaseDirectory.Document, recursive: true });
  }
}

/**
 * Download a remote URL into the question's working directory.
 * Returns the relative path inside `BaseDirectory.Document` — pair
 * with `BaseDirectory.Document` for subsequent fs-plugin calls, or
 * with `absPath()` for shell commands.
 */
export async function downloadInto(args: {
  folderName: string;
  externalRef: string;
  filename: string;
  url: string;
  signal?: AbortSignal;
}): Promise<string> {
  await ensureWorkdir(args.folderName, args.externalRef);
  const res = await tauriFetch(args.url, { signal: args.signal });
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${args.url}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const relPath = `${qdir(args.folderName, args.externalRef)}/${args.filename}`;
  await writeFile(relPath, bytes, { baseDir: BaseDirectory.Document });
  return relPath;
}

/**
 * Resolve a relative-to-Documents path to a `convertFileSrc` URL the
 * webview can render in an `<img>` / `<video>` tag. Cache-busted with
 * `?t=<now>` so re-running a step that overwrites the same file
 * actually refreshes the preview.
 */
export async function asset(relPath: string): Promise<string> {
  const abs = await absPath(relPath);
  const url = convertFileSrc(abs);
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${Date.now()}`;
}

/**
 * Absolute filesystem path for shell commands (ffmpeg etc.). Uses
 * Tauri's `documentDir()` for the platform-native Documents folder
 * (respects Windows OneDrive redirection, macOS sandbox container)
 * and `join()` for native-separator path composition.
 */
export async function absPath(relPath: string): Promise<string> {
  const docDir = await documentDir();
  // `relPath` is always built with forward slashes internally; split
  // and re-join so the final string uses native separators on Windows.
  const segments = relPath.split("/").filter(Boolean);
  return join(docDir, ...segments);
}
