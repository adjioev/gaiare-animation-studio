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

/** How an asset came into being. Lets the gallery / viewer surface
 *  lineage more meaningfully than just `kind`. Defaults to `"uploaded"`
 *  for legacy assets that pre-date this field (load-time backfill). */
export type AssetOriginKind =
  | "uploaded"
  | "transform"
  | "enhance"
  | "extract"
  | "generate"
  | "trim"
  | "stitch";

export type Asset = {
  id: string;
  kind: AssetKind;
  filename: string;
  label: string;
  prompt?: string;
  parentAssetIds?: string[];
  durationSec?: number;
  /** Provenance — added 2026. Old assets backfill to `"uploaded"`. */
  originKind?: AssetOriginKind;
  /** Which model produced this asset. `"flux"` = Flux Kontext edit,
   *  `"gemini"` = Gemini sign-fix, `"seedvr2"` = SeedVR2 upscale,
   *  `"clarity"` = Clarity polish. Absent on uploaded / legacy assets. */
  engine?: "flux" | "gemini" | "seedvr2" | "clarity";
  /** Canonical, Rails-sourced images — protected ("locked") from
   *  deletion. `source` = the original exam image (the default anchor);
   *  `enhanced` / `enhanced_safe` = the super-res variants. Any set role
   *  means locked; `source` keeps its special anchor status. */
  role?: "source" | "enhanced" | "enhanced_safe";
  /** Remote URL a locked variant was fetched from, so it can be
   *  re-downloaded if its file goes missing on load. (The `source` asset
   *  uses `workspace.sourceUrl` instead.) */
  remoteUrl?: string;
  createdAt: number;
};

/** A locked asset can't be deleted from the gallery and is re-fetched if
 *  its file goes missing. Any non-empty `role` marks an asset locked. */
export function isLockedAsset(asset: Asset): boolean {
  return asset.role != null;
}

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
    }
  | {
      id: string;
      kind: "transform";
      /** Single image asset to edit via Flux Kontext (e.g. "remove
       *  yellow arrows"). Result is saved as a new image asset with
       *  `originKind: "transform"` and the source as a parent. */
      inputAssetId: string | null;
      prompt: string;
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
    tabKind: "generate" | "extract" | "trim" | "stitch" | "transform";
    tabId: string;
    /** For generate / transform: the prompt text at send-time. */
    prompt?: string;
    /** For generate / extract / trim / transform: the input asset's
     *  label. */
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

/** Answer + explanation + scene context fetched from Rails when a question
 *  is opened from the browser. Seeds the AI chat so the assistant grounds
 *  prompts in the correct answer before the contractor describes the
 *  animation. Normalised to what the Studio uses (English; snake_case →
 *  camelCase; locale machinery dropped). */
export type QuestionContext = {
  correctAnswer: string | null;
  /** Motion-grounding explanation sections: the verdict, the scene setup,
   *  and the rule. */
  explanation: {
    answer?: string;
    situation?: string;
    why?: string;
  } | null;
  sceneSummary: string | null;
  sceneTypes: string[];
  /** Priority relationships; only the human-readable `reason` is kept. */
  actorRelations: { reason: string }[];
  /** Per-actor obligations; `canProceed` = who moves vs. who stays. */
  actorObligations: { actorId: string; canProceed: boolean; reason: string }[];
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
  /** Ordered list of video asset IDs the contractor has "tagged" for
   *  bulk use — primary (currently only) use case: pre-ordering clips
   *  for the Stitch tab so one click can drop them all in sequence
   *  instead of drag-by-drag. Position in the array IS the displayed
   *  number (index 0 → badge "1"). Tagging is one-key (`T` while
   *  hovering) and persists across reloads. Restricted to
   *  `kind: "video"` by `toggleAssetTag` because Stitch is the only
   *  consumer — image badges would never produce a visible action. */
  taggedAssetIds?: string[];
  /** Correct signs for the question, fetched from Rails on open. The
   *  sign-fix "Load signs from question" turns each into a fix row
   *  (reference = the sign's SVG). Empty/absent when not connected or the
   *  question has no resolvable signs. */
  questionSigns?: { code: string; name: string | null; svgUrl: string }[];
  /** Answer/explanation/scene context for the question, fetched from Rails
   *  on open (same best-effort path as `questionSigns`). Seeds the AI chat.
   *  Absent when not connected, opened manually, or the question lacks it. */
  questionContext?: QuestionContext;
  /** Rails DB id of the question, captured when opened from the browser.
   *  Needed to submit artwork proposals back to Rails (the submissions
   *  endpoint is keyed by DB id). Absent on workspaces created/opened
   *  before this field, or by manual entry — re-open from Rails to set it. */
  railsQuestionId?: number;
  /** The studio job this workspace was opened to fulfil (when opened from the
   *  queue). Passed back on submit so Rails ties the proposal to the job. */
  jobId?: number;
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
 *  built; `stitched` lives here now that the Stitch tab is wired.
 *
 *  `ext` overrides the default extension (jpg for images, mp4 for
 *  videos). Used when the producer knows the file is actually a
 *  different format — e.g. Flux Kontext outputs webp by default, so
 *  TransformTab passes `ext: "webp"`. Without the override the file
 *  would be webp bytes under a .jpg name, which lies to every
 *  downstream consumer (`guessMime`, `guess_content_type` on
 *  re-upload, etc.). */
export function generateAssetFilename(args: {
  id: string;
  kind: AssetKind;
  hint: "source" | "clip" | "frame" | "stitched" | "enhanced";
  ext?: string;
}): string {
  const ext = args.ext ?? (args.kind === "image" ? "jpg" : "mp4");
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
    // Backfill `originKind` on legacy assets — field landed 2026-05.
    // Older workspaces written without it should still load. Heuristic:
    // role:"source" → "uploaded"; everything else stays "uploaded"
    // (the gallery doesn't yet act differently per originKind so a
    // catch-all default is safe). Newly-created assets going forward
    // set the precise kind at construction time.
    const backfilledAssets = parsed.assets.map((a) =>
      a.originKind ? a : ({ ...a, originKind: "uploaded" as const }),
    );
    return {
      workspace: {
        ...parsed,
        assets: backfilledAssets,
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
