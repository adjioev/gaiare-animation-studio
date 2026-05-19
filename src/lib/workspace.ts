// Workspace persistence — version 2.
//
// A workspace is a bag of typed `Asset`s (images, videos, future audio)
// plus minimal session metadata (which question, which source URL, which
// tab was last open). Each `Asset` references a file inside the
// question's working directory and carries genealogy (`parentAssetIds`)
// so the contractor can see where any output came from — important when
// iterating on prompts and comparing v1 against v3.
//
// v1 workspaces (fixed slots: clip1RelPath, midFrameRelPath, etc.) are
// silently migrated to v2 on load. The legacy fields seed the v2
// `assets` array with stable IDs so links don't break.
//
//   ~/Documents/gaiare-animation-studio/
//     ├─ .last-workspace
//     └─ q14/
//         ├─ workspace.json     (v2 schema)
//         ├─ source.jpg
//         ├─ clip-<id>.mp4
//         ├─ frame-<id>.jpg
//         └─ ...

import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { qdir } from "./workdir";

const ROOT = "gaiare-animation-studio";
const POINTER_FILE = `${ROOT}/.last-workspace`;
const WORKSPACE_FILE = "workspace.json";
const WORKSPACE_VERSION = 2;

export type AssetKind = "image" | "video";

export type Asset = {
  id: string;
  kind: AssetKind;
  /** File name relative to the workspace dir — unique per workspace. */
  filename: string;
  /** Human label shown in the gallery; editable. */
  label: string;
  /** Prompt used to produce this asset, if it came from Replicate. */
  prompt?: string;
  /** Genealogy — image-asset id the clip was seeded from, source clip
   *  for an extracted frame, etc. Powers a future "where did this come
   *  from?" view. */
  parentAssetIds?: string[];
  /** Cached probe value so we don't ffprobe on every render. */
  durationSec?: number;
  /** Special-cases. `source` = the original question image, protected
   *  from deletion (it's downloaded from `sourceUrl` and the workspace
   *  re-fetches it on load if missing). */
  role?: "source";
  createdAt: number;
};

export type Workspace = {
  version: number;
  externalRef: string;
  sourceUrl: string;
  assets: Asset[];
  lastTabId?: string;
  updatedAt: number;
};

// ─── Construction ─────────────────────────────────────────────────────

export function makeEmptyWorkspace(args: {
  externalRef: string;
  sourceUrl: string;
}): Workspace {
  return {
    version: WORKSPACE_VERSION,
    externalRef: args.externalRef,
    sourceUrl: args.sourceUrl,
    assets: [],
    updatedAt: Date.now(),
  };
}

export function newAssetId(): string {
  // crypto.randomUUID is available in the Tauri webview (Chromium >= 92).
  return crypto.randomUUID();
}

export function relPathForAsset(externalRef: string, asset: Asset): string {
  return `${qdir(externalRef)}/${asset.filename}`;
}

/**
 * Generate a filename for a new asset. Format includes the asset id so
 * collisions are impossible even if the contractor renames the label.
 */
export function generateAssetFilename(args: {
  id: string;
  kind: AssetKind;
  hint: "source" | "clip" | "frame" | "stitched" | "audio";
}): string {
  const ext =
    args.kind === "image" ? "jpg" : args.kind === "video" ? "mp4" : "mp3";
  return `${args.hint}-${args.id.slice(0, 8)}.${ext}`;
}

// ─── Asset list helpers ───────────────────────────────────────────────

export function upsertAsset(workspace: Workspace, asset: Asset): Workspace {
  const idx = workspace.assets.findIndex((a) => a.id === asset.id);
  const assets =
    idx === -1
      ? [...workspace.assets, asset]
      : workspace.assets.map((a) => (a.id === asset.id ? asset : a));
  return { ...workspace, assets, updatedAt: Date.now() };
}

export function removeAsset(workspace: Workspace, id: string): Workspace {
  return {
    ...workspace,
    assets: workspace.assets.filter((a) => a.id !== id),
    updatedAt: Date.now(),
  };
}

export function findAsset(workspace: Workspace, id: string): Asset | null {
  return workspace.assets.find((a) => a.id === id) ?? null;
}

// ─── Persistence ──────────────────────────────────────────────────────

export async function saveWorkspace(workspace: Workspace): Promise<void> {
  const dir = qdir(workspace.externalRef);
  if (!(await exists(dir, { baseDir: BaseDirectory.Document }))) {
    await mkdir(dir, { baseDir: BaseDirectory.Document, recursive: true });
  }
  const path = `${dir}/${WORKSPACE_FILE}`;
  const payload: Workspace = { ...workspace, updatedAt: Date.now() };
  await writeTextFile(path, JSON.stringify(payload, null, 2), {
    baseDir: BaseDirectory.Document,
  });
  await writePointer(workspace.externalRef);
}

export async function loadWorkspace(
  externalRef: string,
): Promise<Workspace | null> {
  const path = `${qdir(externalRef)}/${WORKSPACE_FILE}`;
  if (!(await exists(path, { baseDir: BaseDirectory.Document }))) {
    return null;
  }
  try {
    const txt = await readTextFile(path, { baseDir: BaseDirectory.Document });
    const parsed = JSON.parse(txt) as Partial<Workspace> &
      LegacyV1Workspace;
    const migrated = await migrateIfNeeded(parsed, externalRef);
    // File-existence pass — drop assets whose file is missing on disk.
    const livingAssets: Asset[] = [];
    for (const asset of migrated.assets) {
      const ok = await exists(relPathForAsset(externalRef, asset), {
        baseDir: BaseDirectory.Document,
      });
      if (ok) livingAssets.push(asset);
    }
    return { ...migrated, assets: livingAssets };
  } catch (err) {
    console.error(`[workspace] failed to load q${externalRef}:`, err);
    return null;
  }
}

export async function listWorkspaces(): Promise<
  Array<{ externalRef: string; updatedAt: number }>
> {
  if (!(await exists(ROOT, { baseDir: BaseDirectory.Document }))) {
    return [];
  }
  const entries = await readDir(ROOT, { baseDir: BaseDirectory.Document });
  const results: Array<{ externalRef: string; updatedAt: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    if (!entry.name.startsWith("q")) continue;
    const externalRef = entry.name.slice(1);
    const wsPath = `${ROOT}/${entry.name}/${WORKSPACE_FILE}`;
    if (!(await exists(wsPath, { baseDir: BaseDirectory.Document }))) continue;
    try {
      const txt = await readTextFile(wsPath, {
        baseDir: BaseDirectory.Document,
      });
      const parsed = JSON.parse(txt) as Workspace;
      results.push({ externalRef, updatedAt: parsed.updatedAt ?? 0 });
    } catch {
      results.push({ externalRef, updatedAt: 0 });
    }
  }
  return results.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readLastWorkspaceRef(): Promise<string | null> {
  if (!(await exists(POINTER_FILE, { baseDir: BaseDirectory.Document }))) {
    return null;
  }
  try {
    const txt = await readTextFile(POINTER_FILE, {
      baseDir: BaseDirectory.Document,
    });
    const ref = txt.trim();
    return ref.length > 0 ? ref : null;
  } catch {
    return null;
  }
}

async function writePointer(externalRef: string): Promise<void> {
  if (!(await exists(ROOT, { baseDir: BaseDirectory.Document }))) {
    await mkdir(ROOT, { baseDir: BaseDirectory.Document, recursive: true });
  }
  await writeTextFile(POINTER_FILE, externalRef, {
    baseDir: BaseDirectory.Document,
  });
}

// ─── Migration (v1 → v2) ──────────────────────────────────────────────

type LegacyV1Workspace = {
  sourceRelPath?: string | null;
  clip1Prompt?: string;
  clip1RelPath?: string | null;
  clip1DurationSec?: number | null;
  midFrameSeconds?: number;
  midFrameRelPath?: string | null;
  clip2Prompt?: string;
  clip2RelPath?: string | null;
  stitchedRelPath?: string | null;
};

async function migrateIfNeeded(
  parsed: Partial<Workspace> & LegacyV1Workspace,
  externalRef: string,
): Promise<Workspace> {
  if ((parsed.version ?? 0) >= WORKSPACE_VERSION && Array.isArray(parsed.assets)) {
    return {
      version: WORKSPACE_VERSION,
      externalRef: parsed.externalRef ?? externalRef,
      sourceUrl: parsed.sourceUrl ?? "",
      assets: parsed.assets,
      lastTabId: parsed.lastTabId,
      updatedAt: parsed.updatedAt ?? Date.now(),
    };
  }

  // v1 → v2: convert the four fixed slots into assets[].
  const assets: Asset[] = [];
  const sourceFilename = parsed.sourceRelPath?.split("/").pop();
  let sourceAssetId: string | undefined;
  if (sourceFilename) {
    sourceAssetId = newAssetId();
    assets.push({
      id: sourceAssetId,
      kind: "image",
      filename: sourceFilename,
      label: "Source",
      role: "source",
      createdAt: parsed.updatedAt ?? Date.now(),
    });
  }
  const clip1Filename = parsed.clip1RelPath?.split("/").pop();
  let clip1AssetId: string | undefined;
  if (clip1Filename) {
    clip1AssetId = newAssetId();
    assets.push({
      id: clip1AssetId,
      kind: "video",
      filename: clip1Filename,
      label: "Clip 1",
      prompt: parsed.clip1Prompt,
      parentAssetIds: sourceAssetId ? [sourceAssetId] : undefined,
      durationSec: parsed.clip1DurationSec ?? undefined,
      createdAt: parsed.updatedAt ?? Date.now(),
    });
  }
  const midFrameFilename = parsed.midFrameRelPath?.split("/").pop();
  let midFrameAssetId: string | undefined;
  if (midFrameFilename) {
    midFrameAssetId = newAssetId();
    assets.push({
      id: midFrameAssetId,
      kind: "image",
      filename: midFrameFilename,
      label: `Mid-frame @ ${parsed.midFrameSeconds?.toFixed(2) ?? "?"} s`,
      parentAssetIds: clip1AssetId ? [clip1AssetId] : undefined,
      createdAt: parsed.updatedAt ?? Date.now(),
    });
  }
  const clip2Filename = parsed.clip2RelPath?.split("/").pop();
  let clip2AssetId: string | undefined;
  if (clip2Filename) {
    clip2AssetId = newAssetId();
    assets.push({
      id: clip2AssetId,
      kind: "video",
      filename: clip2Filename,
      label: "Clip 2",
      prompt: parsed.clip2Prompt,
      parentAssetIds: midFrameAssetId ? [midFrameAssetId] : undefined,
      createdAt: parsed.updatedAt ?? Date.now(),
    });
  }
  const stitchedFilename = parsed.stitchedRelPath?.split("/").pop();
  if (stitchedFilename) {
    assets.push({
      id: newAssetId(),
      kind: "video",
      filename: stitchedFilename,
      label: "Stitched silent master",
      parentAssetIds: [clip1AssetId, clip2AssetId].filter(
        (x): x is string => !!x,
      ),
      createdAt: parsed.updatedAt ?? Date.now(),
    });
  }

  return {
    version: WORKSPACE_VERSION,
    externalRef: parsed.externalRef ?? externalRef,
    sourceUrl: parsed.sourceUrl ?? "",
    assets,
    updatedAt: Date.now(),
  };
}
