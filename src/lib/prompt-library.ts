// Reusable prompt library — saved Wan animation + Flux image-edit
// prompts that work across questions ("remove yellow arrows" applies to
// any exam image). Global, not per-workspace: lives in a single JSON
// file at the workspace-folder root so it survives, syncs via cloud
// (Dropbox/iCloud Documents → 3 contractors share it), and has a clean
// future hook for Rails-backed sync.
//
// Path derives from the configured workspace folder name — if the user
// renames their folder in Settings, the library travels with the
// workspace root (same contract as workspace.json's qdir).

import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

const LIBRARY_FILE = "prompt-library.json";

/** Which prompt surface a saved prompt targets. A Flux body-swap
 *  prompt is nonsense in a Wan animate tab and vice-versa, so the
 *  library hard-filters by this when applying. */
export type PromptKind = "wan" | "flux";

export type SavedPrompt = {
  id: string;
  name: string;
  body: string;
  kind: PromptKind;
  /** Forward-compat for a future Rails-backed sync (GS-12): metadata
   *  like country / cognitive type can attach here without a schema
   *  migration. Empty by default. */
  tags?: string[];
  createdAt: number;
  /** Bumped on save / replace only — NOT on every Apply. Applying
   *  bumps an in-memory copy for session sorting; persisting per-click
   *  would be the noisiest cloud-sync trigger possible. */
  lastUsedAt?: number;
};

function libraryPath(folderName: string): string {
  return `${folderName}/${LIBRARY_FILE}`;
}

export function newPromptId(): string {
  return crypto.randomUUID();
}

/** Load the full library. Returns [] if the file doesn't exist yet or
 *  is unreadable (corrupt JSON shouldn't crash the app — worst case
 *  the user re-saves their prompts). */
export async function loadPromptLibrary(
  folderName: string,
): Promise<SavedPrompt[]> {
  const path = libraryPath(folderName);
  if (!(await exists(path, { baseDir: BaseDirectory.Document }))) {
    return [];
  }
  try {
    const txt = await readTextFile(path, { baseDir: BaseDirectory.Document });
    const parsed = JSON.parse(txt) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Defensive: drop entries missing required fields rather than
    // trusting a hand-edited / partially-synced file.
    //
    // We deliberately accept ANY non-empty `kind` string, not just
    // the current "wan" | "flux" enum. The library is shared via
    // cloud-synced Documents; an older client must not silently prune
    // a newer client's entries (e.g. a future "narration" kind) on
    // load-then-save. Unknown kinds simply never appear in a
    // kind-filtered browse view, so they're inert here but preserved
    // on the next write.
    return parsed.filter(
      (p): p is SavedPrompt =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as SavedPrompt).id === "string" &&
        typeof (p as SavedPrompt).name === "string" &&
        typeof (p as SavedPrompt).body === "string" &&
        typeof (p as SavedPrompt).kind === "string" &&
        (p as SavedPrompt).kind.length > 0,
    );
  } catch (err) {
    console.error("[prompt-library] failed to load:", err);
    return [];
  }
}

async function writeLibrary(
  folderName: string,
  prompts: SavedPrompt[],
): Promise<void> {
  if (!(await exists(folderName, { baseDir: BaseDirectory.Document }))) {
    await mkdir(folderName, { baseDir: BaseDirectory.Document, recursive: true });
  }
  await writeTextFile(
    libraryPath(folderName),
    JSON.stringify(prompts, null, 2),
    { baseDir: BaseDirectory.Document },
  );
}

/**
 * Add or replace a prompt. Read-merge-write: re-loads the file first
 * and merges by id, so a concurrently-synced library from another
 * contractor isn't clobbered wholesale (only the touched entry is
 * overwritten). Returns the updated list.
 */
export async function addPrompt(
  folderName: string,
  prompt: SavedPrompt,
): Promise<SavedPrompt[]> {
  const current = await loadPromptLibrary(folderName);
  const idx = current.findIndex((p) => p.id === prompt.id);
  const next =
    idx === -1
      ? [...current, prompt]
      : current.map((p) => (p.id === prompt.id ? prompt : p));
  await writeLibrary(folderName, next);
  return next;
}

export async function deletePrompt(
  folderName: string,
  id: string,
): Promise<SavedPrompt[]> {
  const current = await loadPromptLibrary(folderName);
  const next = current.filter((p) => p.id !== id);
  await writeLibrary(folderName, next);
  return next;
}

/** Exact-body + same-kind match — used to warn before saving a
 *  near-identical entry (keeps the library from filling with 50
 *  "remove arrows" variants). Returns the existing prompt or null. */
export function findDuplicate(
  prompts: SavedPrompt[],
  body: string,
  kind: PromptKind,
): SavedPrompt | null {
  const trimmed = body.trim();
  return (
    prompts.find((p) => p.kind === kind && p.body.trim() === trimmed) ?? null
  );
}

/** Default library name from the prompt's first non-empty line,
 *  truncated. Used to pre-fill the save form's name input. */
export function suggestPromptName(body: string): string {
  const firstLine =
    body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
}
