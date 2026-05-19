// Per-contractor workspace lock — advisory, filesystem-based.
//
// Each contractor writes their own lock file (`workspace.lock.<id>`)
// rather than sharing a single `workspace.lock`. Three reasons:
//
//   1. Cloud sync (Dropbox / iCloud / OneDrive) doesn't atomically
//      resolve simultaneous writes to the same path — it creates a
//      conflict file ("workspace.lock (Anna's conflicted copy)") that
//      neither contractor sees. Per-contractor filenames eliminate the
//      collision target entirely.
//   2. The "is this our own re-entry?" special case disappears — a
//      contractor never sees their own lock as foreign.
//   3. Heartbeats become natural — each contractor refreshes only
//      their own file.
//
// Stale locks (older than STALE_AFTER_MS) are ignored. The bootstrap
// flow refreshes the lock periodically so an active session stays
// fresh past the stale window.

import {
  BaseDirectory,
  exists,
  readDir,
  readTextFile,
  remove,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { qdir } from "./workdir";

const LOCK_PREFIX = "workspace.lock.";
const STALE_AFTER_MS = 15 * 60 * 1000; // 15 min
/** Refresh interval used by the App heartbeat — kept here so the
 *  STALE_AFTER_MS / HEARTBEAT_MS ratio (3x) is visible. */
export const LOCK_HEARTBEAT_MS = 5 * 60 * 1000; // 5 min

export type WorkspaceLock = {
  contractorId: string;
  acquiredAt: number;
};

function lockFilename(contractorId: string): string {
  // Sanitise so filesystems on every platform stay happy. Same
  // character set as folder names (no slashes / colons / etc.) plus
  // we replace whitespace to avoid the awkward "anna smith" → " "
  // file name.
  const safe = contractorId.replace(/[<>:"/\\|?*\x00-\x1f\s]/g, "_");
  return `${LOCK_PREFIX}${safe || "anonymous"}`;
}

function lockPath(
  folderName: string,
  externalRef: string,
  contractorId: string,
): string {
  return `${qdir(folderName, externalRef)}/${lockFilename(contractorId)}`;
}

export function isStale(lock: WorkspaceLock, now: number = Date.now()): boolean {
  return now - lock.acquiredAt > STALE_AFTER_MS;
}

/**
 * Write (or refresh — same operation) this contractor's lock file.
 * Idempotent and safe to call on a heartbeat.
 */
export async function acquireLock(
  folderName: string,
  externalRef: string,
  contractorId: string,
): Promise<void> {
  const lock: WorkspaceLock = { contractorId, acquiredAt: Date.now() };
  await writeTextFile(
    lockPath(folderName, externalRef, contractorId),
    JSON.stringify(lock, null, 2),
    { baseDir: BaseDirectory.Document },
  );
}

/**
 * Remove this contractor's lock. Best-effort — stale locks self-expire.
 */
export async function releaseLock(
  folderName: string,
  externalRef: string,
  contractorId: string,
): Promise<void> {
  const path = lockPath(folderName, externalRef, contractorId);
  if (await exists(path, { baseDir: BaseDirectory.Document })) {
    try {
      await remove(path, { baseDir: BaseDirectory.Document });
    } catch {
      // ignore — stale locks self-expire
    }
  }
}

/**
 * List all fresh, foreign locks on the workspace. Excludes the
 * caller's own lock and any stale ones. Caller surfaces these in the
 * UI as a "someone else is editing" warning.
 */
export async function listForeignFreshLocks(
  folderName: string,
  externalRef: string,
  selfContractorId: string,
): Promise<WorkspaceLock[]> {
  const dir = qdir(folderName, externalRef);
  if (!(await exists(dir, { baseDir: BaseDirectory.Document }))) return [];
  const entries = await readDir(dir, { baseDir: BaseDirectory.Document });
  const out: WorkspaceLock[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!entry.name.startsWith(LOCK_PREFIX)) continue;
    try {
      const txt = await readTextFile(`${dir}/${entry.name}`, {
        baseDir: BaseDirectory.Document,
      });
      const parsed = JSON.parse(txt) as WorkspaceLock;
      if (
        typeof parsed.contractorId !== "string" ||
        typeof parsed.acquiredAt !== "number"
      ) {
        continue;
      }
      if (parsed.contractorId === selfContractorId) continue;
      if (isStale(parsed)) continue;
      out.push(parsed);
    } catch {
      // Malformed lock — skip silently.
    }
  }
  return out;
}
