// Workspace persistence — version 2.
//
// A workspace is a bag of typed `Asset`s (images, videos, future audio)
// plus minimal session metadata (which question, source URL, open tabs).
// Each `Asset` references a file inside the question's working dir and
// carries genealogy (`parentAssetIds`) so the contractor can see where
// any output came from when iterating on prompts.
//
//   ~/Documents/<folderName>/
//     ├─ _last-workspace
//     └─ q14/
//         ├─ workspace.json
//         ├─ source-<id>.jpg
//         ├─ clip-<id>.mp4
//         └─ frame-<id>.jpg

import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { qdir } from "./workdir";

// NOT a dotfile — Tauri's fs scope globs follow bash conventions and
// `*` / `**` won't match a name starting with `.`. Keeping the file
// non-hidden keeps the scope rules simple.
const POINTER_FILENAME = "_last-workspace";
const WORKSPACE_FILE = "workspace.json";
const WORKSPACE_VERSION = 2;

function pointerPath(folderName: string): string {
  return `${folderName}/${POINTER_FILENAME}`;
}

export type AssetKind = "image" | "video";

export type Asset = {
  id: string;
  kind: AssetKind;
  filename: string;
  label: string;
  prompt?: string;
  parentAssetIds?: string[];
  durationSec?: number;
  /** Special-cases. `source` = the original question image, protected
   *  from deletion (the workspace re-fetches it from `sourceUrl` on
   *  load if missing). */
  role?: "source";
  createdAt: number;
};

/** Optional per-tab override for the strip label. Without it the title
 *  is derived from the tab's content (prompt first line, scrub time,
 *  trim range) — fine for the current 3 tab kinds, but those
 *  derivations stop being meaningful for future kinds that are
 *  distinguished by a non-textual selection (e.g. narration voice). A
 *  contractor-set `userLabel` always wins. */
export type PersistedTab =
  | {
      id: string;
      kind: "generate";
      inputAssetId: string | null;
      prompt: string;
      userLabel?: string;
    }
  | {
      id: string;
      kind: "extract";
      inputAssetId: string | null;
      /** `null` = not yet seeded (use mid-clip on first mount). 0 is a
       *  legitimate value (extracting the opening frame) so we can't
       *  use it as a sentinel. */
      scrubSeconds: number | null;
      userLabel?: string;
    }
  | {
      id: string;
      kind: "trim";
      inputAssetId: string | null;
      /** Trim range expressed as seconds from clip start. `null` = not
       *  yet seeded; on first mount we seed to [0, duration]. */
      trimStart: number | null;
      trimEnd: number | null;
      userLabel?: string;
    }
  | {
      id: string;
      kind: "stitch";
      /** Ordered video asset IDs to concatenate. Duplicates allowed
       *  — a contractor may want to repeat a clip ("hold this moment"
       *  effect). Save is gated to len >= 2 in StitchTab. */
      inputAssetIds: string[];
      userLabel?: string;
    };

/** A single turn in the AI prompt-author chat. Lives per-workspace so
 *  the assistant remembers the conversation across tab switches — the
 *  user keeps iterating on the same animation idea even if they hop
 *  between Generate / Extract / Trim tabs to set up the next attempt. */
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** When set, the renderer snapshots which tab was active when this
   *  message was sent. The assistant uses it to ground "the prompt" /
   *  "the input frame" references — without it the chat is blind to
   *  the studio state. */
  tabContext?: {
    tabKind: "generate" | "extract" | "trim" | "stitch";
    tabId: string;
    /** For generate: the prompt text at send-time. */
    prompt?: string;
    /** For generate / extract / trim: the input asset's label. */
    inputAssetLabel?: string;
  };
  /** Cumulative token cost so the UI can render "this session ate $X". */
  promptTokens?: number;
  completionTokens?: number;
  /** 6-char hash of the skills doc (`src/skills/wan-i2v.md`) that
   *  drove the assistant for this turn. When a regression turns out
   *  to be caused by a skills edit, you read the fingerprint off
   *  workspace.json and `git log src/skills/wan-i2v.md` lines up the
   *  diff. Set only on assistant messages — user didn't author the
   *  skills, only the assistant turn was driven by them. */
  skillsFingerprint?: string;
  /** Fireworks `finish_reason` for assistant messages — `"stop"`
   *  (clean), `"length"` (truncated by max_tokens), `"content_filter"`,
   *  etc. UI surfaces a warning when not `"stop"` so the user knows
   *  the bubble may be cut off mid-thought. */
  finishReason?: string;
  createdAt: number;
};

export type Workspace = {
  version: number;
  externalRef: string;
  sourceUrl: string;
  assets: Asset[];
  tabs: PersistedTab[];
  activeTabId: string | null;
  /** AI prompt-author conversation. Optional for backwards compat —
   *  old workspaces load with an empty chat. Per-workspace because the
   *  conversation thread is tied to one question's animation work. */
  chat?: ChatMessage[];
  updatedAt: number;
};

export function newAssetId(): string {
  return crypto.randomUUID();
}

export function newTabId(): string {
  return crypto.randomUUID();
}

export function newChatMessageId(): string {
  return crypto.randomUUID();
}

export function relPathForAsset(
  folderName: string,
  externalRef: string,
  asset: Asset,
): string {
  return `${qdir(folderName, externalRef)}/${asset.filename}`;
}

/** Asset filename hints. Add a hint here only when the corresponding
 *  tab kind / AssetKind lands. `audio` will follow when narration is
 *  built; `stitched` lives here now that the Stitch tab is wired. */
export function generateAssetFilename(args: {
  id: string;
  kind: AssetKind;
  hint: "source" | "clip" | "frame" | "stitched";
}): string {
  const ext = args.kind === "image" ? "jpg" : "mp4";
  return `${args.hint}-${args.id}.${ext}`;
}

export function makeEmptyWorkspace(args: {
  externalRef: string;
  sourceUrl: string;
}): Workspace {
  return {
    version: WORKSPACE_VERSION,
    externalRef: args.externalRef,
    sourceUrl: args.sourceUrl,
    assets: [],
    tabs: [],
    activeTabId: null,
    updatedAt: Date.now(),
  };
}

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

export async function saveWorkspace(
  folderName: string,
  workspace: Workspace,
): Promise<void> {
  const dir = qdir(folderName, workspace.externalRef);
  if (!(await exists(dir, { baseDir: BaseDirectory.Document }))) {
    await mkdir(dir, { baseDir: BaseDirectory.Document, recursive: true });
  }
  const path = `${dir}/${WORKSPACE_FILE}`;
  const payload: Workspace = { ...workspace, updatedAt: Date.now() };
  await writeTextFile(path, JSON.stringify(payload, null, 2), {
    baseDir: BaseDirectory.Document,
  });
  await writePointer(folderName, workspace.externalRef);
}

export type LoadResult = {
  workspace: Workspace;
  /** Asset IDs that were recorded in workspace.json but whose files
   *  weren't on disk at load time. We DON'T drop them from the
   *  workspace — the caller can surface them in the UI and the user
   *  decides whether to remove (e.g. if a sync delay restored the
   *  file, a save round-trip would otherwise wipe the entry forever). */
  missingAssetIds: string[];
};

export async function loadWorkspace(
  folderName: string,
  externalRef: string,
): Promise<LoadResult | null> {
  const path = `${qdir(folderName, externalRef)}/${WORKSPACE_FILE}`;
  if (!(await exists(path, { baseDir: BaseDirectory.Document }))) {
    return null;
  }
  try {
    const txt = await readTextFile(path, { baseDir: BaseDirectory.Document });
    const parsed = JSON.parse(txt) as Workspace;
    if (parsed.version !== WORKSPACE_VERSION) {
      throw new Error(
        `workspace.json version ${parsed.version} not supported (expected ${WORKSPACE_VERSION})`,
      );
    }
    const missingAssetIds: string[] = [];
    for (const asset of parsed.assets) {
      const present = await exists(
        relPathForAsset(folderName, externalRef, asset),
        { baseDir: BaseDirectory.Document },
      );
      if (!present) missingAssetIds.push(asset.id);
    }
    return {
      workspace: {
        ...parsed,
        // Keep assets intact even when files are missing — if we
        // pruned, the next autosave would write back a strictly
        // shrinking list and orphans would never recover.
        tabs: Array.isArray(parsed.tabs) ? parsed.tabs : [],
        activeTabId: parsed.activeTabId ?? null,
      },
      missingAssetIds,
    };
  } catch (err) {
    console.error(`[workspace] failed to load q${externalRef}:`, err);
    return null;
  }
}

export async function listWorkspaces(
  folderName: string,
): Promise<Array<{ externalRef: string; updatedAt: number }>> {
  if (!(await exists(folderName, { baseDir: BaseDirectory.Document }))) {
    return [];
  }
  const entries = await readDir(folderName, {
    baseDir: BaseDirectory.Document,
  });
  const results: Array<{ externalRef: string; updatedAt: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    if (!entry.name.startsWith("q")) continue;
    const externalRef = entry.name.slice(1);
    const wsPath = `${folderName}/${entry.name}/${WORKSPACE_FILE}`;
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

export async function readLastWorkspaceRef(
  folderName: string,
): Promise<string | null> {
  const path = pointerPath(folderName);
  if (!(await exists(path, { baseDir: BaseDirectory.Document }))) {
    return null;
  }
  try {
    const txt = await readTextFile(path, {
      baseDir: BaseDirectory.Document,
    });
    const ref = txt.trim();
    return ref.length > 0 ? ref : null;
  } catch {
    return null;
  }
}

async function writePointer(
  folderName: string,
  externalRef: string,
): Promise<void> {
  if (!(await exists(folderName, { baseDir: BaseDirectory.Document }))) {
    await mkdir(folderName, {
      baseDir: BaseDirectory.Document,
      recursive: true,
    });
  }
  await writeTextFile(pointerPath(folderName), externalRef, {
    baseDir: BaseDirectory.Document,
  });
}
