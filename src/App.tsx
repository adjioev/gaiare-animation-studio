import { useEffect, useRef, useState } from "react";
import { BaseDirectory, exists, remove } from "@tauri-apps/plugin-fs";
import "./App.css";
import {
  asset as resolveAsset,
  downloadInto,
  ensureWorkdir,
  qdir,
} from "./lib/workdir";
import {
  findAsset,
  generateAssetFilename,
  listWorkspaces,
  loadWorkspace,
  makeEmptyWorkspace,
  newAssetId,
  newTabId,
  readLastWorkspaceRef,
  relPathForAsset,
  removeAsset,
  saveWorkspace,
  upsertAsset,
  type Asset,
  type AssetKind,
  type PersistedTab,
  type Workspace,
} from "./lib/workspace";
import {
  acquireLock,
  LOCK_HEARTBEAT_MS,
  listForeignFreshLocks,
  releaseLock,
} from "./lib/lock";
import { AssetGallery } from "./components/AssetGallery";
import { TabStrip } from "./components/TabStrip";
import { GenerateClipTab } from "./components/tabs/GenerateClipTab";
import { ExtractFrameTab } from "./components/tabs/ExtractFrameTab";
import { SettingsModal } from "./components/SettingsModal";
import { Button, errorMessage, shorten } from "./components/ui";
import { loadSettings, saveSettings, type Settings } from "./lib/settings";

const DEFAULT_EXTERNAL_REF = "14";
const DEFAULT_SOURCE_URL =
  "https://hel1.your-objectstorage.com/gaiare-media/georgia/driving-tests/images/q14.jpg";

const DEFAULT_PROMPT = `The red sedan in the upper background turns left through the intersection, following the yellow curved arrow on the road. The car continues driving leftward, growing slightly larger as it approaches the camera, and exits the frame at the bottom-left edge.

By the end of the clip, the red sedan is completely off-screen — no longer visible in the frame.

The yellow van in the foreground does NOT move. The van remains stationary throughout.

Static camera, no zoom, no pan. Photorealistic.`;

function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [availableWorkspaces, setAvailableWorkspaces] = useState<
    Array<{ externalRef: string; updatedAt: number }>
  >([]);
  const [saveBlinker, setSaveBlinker] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>(
    {},
  );
  const [unsavedTabIds, setUnsavedTabIds] = useState<Set<string>>(new Set());
  const [globalError, setGlobalError] = useState<string | null>(null);
  /** Non-fatal warnings surfaced as banners at the top of the editor —
   *  failed source-image download, asset files missing from disk, a
   *  competing contractor's lock. */
  /** Structured warnings keyed by id so a re-pushed warning with a new
   *  message (e.g. updated missing-asset count) replaces the previous
   *  one instead of being deduped by exact-string equality. */
  type Warning = { id: string; message: string };
  const [warnings, setWarnings] = useState<Warning[]>([]);

  const folderName = settings.workspaceFolderName;
  /** Effective contractor identity. Empty / unset = `null` so callers
   *  can gate operations (Generate is blocked until set). */
  const contractorId = settings.contractorId?.trim() || null;

  /** Tracks the currently-held lock so the unmount cleanup releases
   *  the right file even after workspace switches or settings
   *  changes — closing over `workspace` / `folderName` from the
   *  cleanup effect's empty deps would capture stale values. */
  const lockRef = useRef<
    { folderName: string; externalRef: string; contractorId: string } | null
  >(null);

  function pushWarning(id: string, message: string) {
    setWarnings((w) => {
      const idx = w.findIndex((x) => x.id === id);
      if (idx === -1) return [...w, { id, message }];
      const next = [...w];
      next[idx] = { id, message };
      return next;
    });
  }
  function dismissWarning(id: string) {
    setWarnings((w) => w.filter((x) => x.id !== id));
  }
  function clearWarnings() {
    setWarnings([]);
  }

  // ─── Lock lifecycle helpers ───────────────────────────────────────

  async function adoptLock(externalRef: string) {
    // Release whatever lock we were previously holding — awaited so a
    // rapid switch between two refs can't race release-A → acquire-A.
    if (lockRef.current) {
      await releaseLock(
        lockRef.current.folderName,
        lockRef.current.externalRef,
        lockRef.current.contractorId,
      );
      lockRef.current = null;
    }
    if (!contractorId) return; // Gate: no identity, no lock writes.
    // ensureWorkdir is the caller's responsibility — the workspace
    // dir must exist before we drop a lock file into it.
    const foreign = await listForeignFreshLocks(
      folderName,
      externalRef,
      contractorId,
    );
    if (foreign.length > 0) {
      const names = foreign
        .map((l) => `"${l.contractorId}" (${formatRelative(l.acquiredAt)})`)
        .join(", ");
      pushWarning(
        `lock-${externalRef}`,
        `⚠ q${externalRef} is also being edited by ${names}. Save your work carefully — last write wins.`,
      );
    } else {
      dismissWarning(`lock-${externalRef}`);
    }
    await acquireLock(folderName, externalRef, contractorId);
    lockRef.current = { folderName, externalRef, contractorId };
  }

  // ─── Bootstrap / reload on folderName change ──────────────────────

  useEffect(() => {
    setBootstrapped(false);
    clearWarnings();
    (async () => {
      try {
        const list = await listWorkspaces(folderName);
        setAvailableWorkspaces(list);

        const lastRef = await readLastWorkspaceRef(folderName);
        const candidate =
          lastRef ?? list[0]?.externalRef ?? DEFAULT_EXTERNAL_REF;
        const loadResult = await loadWorkspace(folderName, candidate);
        let ws: Workspace;
        if (loadResult) {
          ws = loadResult.workspace;
          if (loadResult.missingAssetIds.length > 0) {
            const names = loadResult.missingAssetIds
              .map((id) => ws.assets.find((a) => a.id === id)?.label ?? id)
              .join(", ");
            pushWarning(
              `missing-${ws.externalRef}`,
              `${loadResult.missingAssetIds.length} asset file(s) missing on disk: ${names}. They're kept in workspace.json so they recover if the file reappears — delete from the sidebar if you want to drop them permanently.`,
            );
          }
        } else {
          ws = makeEmptyWorkspace({
            externalRef: candidate,
            sourceUrl:
              candidate === DEFAULT_EXTERNAL_REF ? DEFAULT_SOURCE_URL : "",
          });
        }

        // Ensure the workspace dir exists BEFORE adopting the lock —
        // acquireLock writes a file into qNN/, which must already be a
        // directory. `ensureSourceAsset` ensures it too but only when
        // `sourceUrl` is set; a "New" workspace without URL would skip
        // it and ENOENT here.
        await ensureWorkdir(folderName, candidate);
        ws = await ensureSourceAsset(ws);
        ws = ensureAtLeastOneTab(ws);

        await adoptLock(ws.externalRef);

        setWorkspace(ws);
        setUnsavedTabIds(new Set());
        await refreshThumbnails(ws);
      } catch (e) {
        setGlobalError(errorMessage(e));
      } finally {
        setBootstrapped(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderName]);

  // If the user opens the app with no contractorId, loads a workspace,
  // *then* sets their name in Settings — the bootstrap effect won't
  // re-run (its dep is only `[folderName]`) and the heartbeat won't
  // fire for 5 minutes. Re-adopt the lock when contractorId
  // transitions to a truthy value so the lock file appears immediately.
  useEffect(() => {
    if (!bootstrapped || !workspace || !contractorId) return;
    if (lockRef.current?.contractorId === contractorId) return;
    void adoptLock(workspace.externalRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapped, workspace?.externalRef, contractorId]);

  // Lock heartbeat — refresh our own lock so STALE_AFTER_MS doesn't
  // trip for a long active session. Also re-checks for foreign locks
  // in case a teammate opened the same workspace mid-session.
  useEffect(() => {
    if (!workspace || !contractorId) return;
    const tick = async () => {
      try {
        await acquireLock(folderName, workspace.externalRef, contractorId);
        const foreign = await listForeignFreshLocks(
          folderName,
          workspace.externalRef,
          contractorId,
        );
        if (foreign.length > 0) {
          const names = foreign
            .map(
              (l) => `"${l.contractorId}" (${formatRelative(l.acquiredAt)})`,
            )
            .join(", ");
          pushWarning(
            `lock-${workspace.externalRef}`,
            `⚠ q${workspace.externalRef} is also being edited by ${names}. Save your work carefully — last write wins.`,
          );
        } else {
          dismissWarning(`lock-${workspace.externalRef}`);
        }
      } catch (e) {
        console.warn("[lock] heartbeat failed", e);
      }
    };
    const id = window.setInterval(tick, LOCK_HEARTBEAT_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.externalRef, folderName, contractorId]);

  // Release lock on app close (or hot-reload teardown in dev). Reads
  // from a ref so the cleanup sees the *current* lock identity, not
  // whatever values were captured at mount.
  useEffect(() => {
    return () => {
      const held = lockRef.current;
      if (held) {
        void releaseLock(held.folderName, held.externalRef, held.contractorId);
        lockRef.current = null;
      }
    };
  }, []);

  // Debounced autosave for prose/prompt edits. Critical writes (asset
  // create, asset delete, tab close) call saveWorkspace directly to
  // close the race where this timer's cancellation drops the latest
  // state.
  useEffect(() => {
    if (!bootstrapped || !workspace) return;
    setSaveBlinker("saving");
    const id = window.setTimeout(async () => {
      try {
        await saveWorkspace(folderName, workspace);
        setSaveBlinker("saved");
        setAvailableWorkspaces(await listWorkspaces(folderName));
        window.setTimeout(() => setSaveBlinker("idle"), 1200);
      } catch (e) {
        console.error("[workspace] save failed", e);
        setSaveBlinker("idle");
      }
    }, 500);
    return () => window.clearTimeout(id);
  }, [bootstrapped, workspace, folderName]);

  // ─── Workspace operations ─────────────────────────────────────────

  async function switchWorkspace(externalRef: string) {
    clearWarnings();
    const loadResult = await loadWorkspace(folderName, externalRef);
    let ws: Workspace;
    if (loadResult) {
      ws = loadResult.workspace;
      if (loadResult.missingAssetIds.length > 0) {
        pushWarning(
          `missing-${externalRef}`,
          `${loadResult.missingAssetIds.length} asset file(s) missing on disk for q${externalRef}.`,
        );
      }
    } else {
      ws = makeEmptyWorkspace({ externalRef, sourceUrl: "" });
    }
    await ensureWorkdir(folderName, externalRef);
    ws = await ensureSourceAsset(ws);
    ws = ensureAtLeastOneTab(ws);

    await adoptLock(ws.externalRef);

    setWorkspace(ws);
    setUnsavedTabIds(new Set());
    await refreshThumbnails(ws);
  }

  async function newWorkspace() {
    const ref = window.prompt("New workspace — external_ref (e.g. 15):");
    if (!ref?.trim()) return;
    const url = window.prompt(
      "Source image URL (CDN, leave empty to set later):",
    );
    clearWarnings();
    let ws = makeEmptyWorkspace({
      externalRef: ref.trim(),
      sourceUrl: url?.trim() ?? "",
    });
    await ensureWorkdir(folderName, ws.externalRef);
    ws = await ensureSourceAsset(ws);
    ws = ensureAtLeastOneTab(ws);

    await adoptLock(ws.externalRef);

    setWorkspace(ws);
    setUnsavedTabIds(new Set());
    await refreshThumbnails(ws);
  }

  async function ensureSourceAsset(ws: Workspace): Promise<Workspace> {
    if (!ws.sourceUrl) return ws;
    const existing = ws.assets.find((a) => a.role === "source");
    if (existing) return ws;
    try {
      await ensureWorkdir(folderName, ws.externalRef);
      const id = newAssetId();
      const filename = generateAssetFilename({
        id,
        kind: "image",
        hint: "source",
      });
      await downloadInto({
        folderName,
        externalRef: ws.externalRef,
        filename,
        url: ws.sourceUrl,
      });
      const a: Asset = {
        id,
        kind: "image",
        filename,
        label: "Source",
        role: "source",
        createdAt: Date.now(),
      };
      return upsertAsset(ws, a);
    } catch (e) {
      // Surface to the user — silently dropping leaves them staring at
      // a half-set-up workspace with no signal about why.
      pushWarning(
        `source-${ws.externalRef}`,
        `Couldn't fetch source image from ${ws.sourceUrl}: ${errorMessage(e)}. Generate Clip won't work until this is resolved.`,
      );
      return ws;
    }
  }

  function ensureAtLeastOneTab(ws: Workspace): Workspace {
    if (ws.tabs.length > 0) {
      return { ...ws, activeTabId: ws.activeTabId ?? ws.tabs[0]!.id };
    }
    const sourceAsset = ws.assets.find((a) => a.role === "source");
    const tabId = newTabId();
    const seedTab: PersistedTab = {
      id: tabId,
      kind: "generate",
      inputAssetId: sourceAsset?.id ?? null,
      prompt: DEFAULT_PROMPT,
    };
    return { ...ws, tabs: [seedTab], activeTabId: tabId };
  }

  async function refreshThumbnails(ws: Workspace) {
    const next: Record<string, string> = {};
    for (const a of ws.assets) {
      const rel = relPathForAsset(folderName, ws.externalRef, a);
      try {
        next[a.id] = await resolveAsset(rel);
      } catch {
        // skip unresolvable
      }
    }
    setThumbnailUrls(next);
  }

  // ─── Asset operations ─────────────────────────────────────────────

  async function handleAssetSave(newAsset: Asset) {
    if (!workspace) return;
    const next = upsertAsset(workspace, newAsset);
    setWorkspace(next);
    // Persist NOW, not via the debounced effect — if the user closes
    // the tab or quits the app in the next 500 ms, the debounced
    // timer is cancelled and the asset entry is lost while the file
    // already sits on disk (orphan). Awaiting here closes that race.
    try {
      await saveWorkspace(folderName, next);
    } catch (e) {
      console.error("[workspace] immediate save after asset save failed", e);
    }
    await refreshThumbnails(next);
  }

  async function handleAssetDelete(id: string) {
    if (!workspace) return;
    const a = findAsset(workspace, id);
    if (!a) return;
    if (a.role === "source") {
      window.alert(
        "The source image is protected — it's the workspace anchor.\nIf you really want to swap it, create a new workspace.",
      );
      return;
    }
    const ok = window.confirm(
      `Delete "${a.label}"?\n\nThe file will be removed from disk.`,
    );
    if (!ok) return;

    const rel = relPathForAsset(folderName, workspace.externalRef, a);
    try {
      if (await exists(rel, { baseDir: BaseDirectory.Document })) {
        await remove(rel, { baseDir: BaseDirectory.Document });
      }
    } catch (e) {
      console.warn(
        "[workspace] file delete failed; pruning from workspace anyway",
        e,
      );
    }
    let next = removeAsset(workspace, id);
    next = {
      ...next,
      tabs: next.tabs.map((t) =>
        t.inputAssetId === id ? { ...t, inputAssetId: null } : t,
      ),
    };
    setWorkspace(next);
    try {
      await saveWorkspace(folderName, next);
    } catch (e) {
      console.error("[workspace] immediate save after asset delete failed", e);
    }
    setThumbnailUrls((prev) => {
      const { [id]: _gone, ...rest } = prev;
      return rest;
    });
  }

  // ─── Tab operations ───────────────────────────────────────────────

  function selectAssetForActiveTab(assetId: string) {
    if (!workspace || !workspace.activeTabId) return;
    const a = findAsset(workspace, assetId);
    if (!a) return;
    const active = workspace.tabs.find((t) => t.id === workspace.activeTabId);
    if (!active) return;
    if (
      (active.kind === "generate" && a.kind === "image") ||
      (active.kind === "extract" && a.kind === "video")
    ) {
      patchTab(active.id, { inputAssetId: assetId });
    }
  }

  function pickIncompatibleAsset(assetId: string, kind: AssetKind) {
    if (!workspace) return;
    const tabKind: "generate" | "extract" =
      kind === "image" ? "generate" : "extract";
    openNewTab(tabKind, assetId);
  }

  function openNewTab(
    kind: "generate" | "extract",
    seedInputAssetId: string | null = null,
  ) {
    if (!workspace) return;
    const id = newTabId();
    const seedAsset = seedInputAssetId
      ? findAsset(workspace, seedInputAssetId)
      : kind === "generate"
        ? workspace.assets.find((a) => a.kind === "image" && a.role === "source")
        : workspace.assets.find((a) => a.kind === "video");
    const inputAssetId = seedAsset?.id ?? null;

    const tab: PersistedTab =
      kind === "generate"
        ? { id, kind: "generate", inputAssetId, prompt: DEFAULT_PROMPT }
        : { id, kind: "extract", inputAssetId, scrubSeconds: null };
    setWorkspace({
      ...workspace,
      tabs: [...workspace.tabs, tab],
      activeTabId: id,
    });
  }

  async function closeTab(id: string) {
    if (!workspace) return;
    if (unsavedTabIds.has(id)) {
      const ok = window.confirm(
        "This tab has an unsaved preview. Close anyway?\nThe preview can be regenerated.",
      );
      if (!ok) return;
    }
    const nextTabs = workspace.tabs.filter((t) => t.id !== id);
    let nextActive = workspace.activeTabId;
    if (nextActive === id) {
      const idx = workspace.tabs.findIndex((t) => t.id === id);
      const fallback =
        nextTabs[Math.max(0, idx - 1)] ??
        nextTabs[nextTabs.length - 1] ??
        null;
      nextActive = fallback?.id ?? null;
    }
    const next = { ...workspace, tabs: nextTabs, activeTabId: nextActive };
    setWorkspace(next);
    setUnsavedTabIds((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    // Persist now — tab closes are the most common "I'm done with this
    // train of thought" event and we want them to land before any
    // potential app crash.
    try {
      await saveWorkspace(folderName, next);
    } catch (e) {
      console.error("[workspace] immediate save after tab close failed", e);
    }
  }

  function activateTab(id: string) {
    if (!workspace) return;
    setWorkspace({ ...workspace, activeTabId: id });
  }

  function patchTab(id: string, patch: Partial<PersistedTab>) {
    if (!workspace) return;
    setWorkspace({
      ...workspace,
      tabs: workspace.tabs.map((t) =>
        t.id === id ? ({ ...t, ...patch } as PersistedTab) : t,
      ),
    });
  }

  function setTabUnsaved(id: string, unsaved: boolean) {
    setUnsavedTabIds((prev) => {
      const next = new Set(prev);
      if (unsaved) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function tabTitle(tab: PersistedTab): string {
    if (tab.kind === "generate") {
      const firstLine = (tab.prompt ?? "").trim().split("\n")[0] ?? "";
      return shorten(firstLine, 28) || "New generate";
    }
    const source = tab.inputAssetId
      ? findAsset(workspace!, tab.inputAssetId)
      : null;
    const s = tab.scrubSeconds ?? 0;
    return source
      ? `Extract @ ${s.toFixed(1)}s from ${shorten(source.label, 18)}`
      : "New extract";
  }

  // ─── Render ───────────────────────────────────────────────────────

  if (!bootstrapped) {
    return (
      <main className="flex h-full items-center justify-center text-sm text-neutral-500">
        Loading workspace…
      </main>
    );
  }
  if (globalError) {
    return (
      <main className="p-6 text-sm text-rose-300">Fatal: {globalError}</main>
    );
  }
  if (!workspace) {
    return <main className="p-6 text-sm text-neutral-500">No workspace.</main>;
  }

  const activeTab = workspace.tabs.find((t) => t.id === workspace.activeTabId);
  const activeKind: AssetKind = activeTab?.kind === "extract" ? "video" : "image";
  const activeInputThumb =
    activeTab?.inputAssetId
      ? thumbnailUrls[activeTab.inputAssetId] ?? null
      : null;

  return (
    <main className="flex h-full bg-black text-neutral-200">
      <AssetGallery
        assets={workspace.assets}
        selectedAssetId={activeTab?.inputAssetId ?? null}
        onSelect={selectAssetForActiveTab}
        onRequestDelete={handleAssetDelete}
        activeKind={activeKind}
        onPickIncompatible={pickIncompatibleAsset}
        thumbnailUrls={thumbnailUrls}
      />

      <div className="min-w-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-neutral-800 bg-black/95 px-6 py-3 backdrop-blur">
          <h1 className="text-sm font-semibold tracking-tight">
            Gaiare Animation Studio
          </h1>
          <span className="text-xs text-neutral-600">·</span>
          <span className="text-xs text-neutral-500">
            q{workspace.externalRef}
          </span>
          {settings.contractorId && (
            <>
              <span className="text-xs text-neutral-600">·</span>
              <span className="text-xs text-neutral-500">
                {settings.contractorId}
              </span>
            </>
          )}

          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-neutral-600">Workspace</span>
            <select
              value={workspace.externalRef}
              onChange={(e) => switchWorkspace(e.currentTarget.value)}
              className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200"
            >
              {availableWorkspaces.length === 0 && (
                <option value={workspace.externalRef}>
                  q{workspace.externalRef}
                </option>
              )}
              {availableWorkspaces.map((w) => (
                <option key={w.externalRef} value={w.externalRef}>
                  q{w.externalRef}
                </option>
              ))}
            </select>
            <Button variant="secondary" onClick={newWorkspace}>
              + New
            </Button>
            <button
              onClick={() => setSettingsOpen(true)}
              title="Settings"
              className="rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-600 hover:text-white"
            >
              ⚙
            </button>
            {saveBlinker !== "idle" && (
              <span
                className={
                  saveBlinker === "saving"
                    ? "text-xs text-amber-300"
                    : "text-xs text-emerald-300"
                }
              >
                {saveBlinker === "saving" ? "saving…" : "saved"}
              </span>
            )}
          </div>
        </header>

        {(!contractorId || warnings.length > 0) && (
          <div className="space-y-2 border-b border-amber-900/40 bg-amber-950/20 px-6 py-3">
            {!contractorId && (
              <div className="flex items-start gap-2 text-xs text-amber-200">
                <span aria-hidden>⚠</span>
                <span className="flex-1">
                  Set your contractor name in{" "}
                  <button
                    onClick={() => setSettingsOpen(true)}
                    className="underline hover:text-white"
                  >
                    Settings
                  </button>{" "}
                  before generating clips. Locks rely on it to warn
                  teammates that you're editing this workspace.
                </span>
              </div>
            )}
            {warnings.map((w) => (
              <div
                key={w.id}
                className="flex items-start gap-2 text-xs text-amber-200"
              >
                <span aria-hidden>⚠</span>
                <span className="flex-1">{w.message}</span>
                <button
                  onClick={() => dismissWarning(w.id)}
                  className="rounded px-1 text-amber-400 hover:bg-amber-900/30"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <TabStrip
          tabs={workspace.tabs}
          activeTabId={workspace.activeTabId}
          unsavedTabIds={unsavedTabIds}
          onActivate={activateTab}
          onClose={closeTab}
          onNew={openNewTab}
          tabTitle={tabTitle}
        />

        <div className="p-6">
          {activeTab?.kind === "generate" && (
            <GenerateClipTab
              tabId={activeTab.id}
              folderName={folderName}
              externalRef={workspace.externalRef}
              inputAsset={
                activeTab.inputAssetId
                  ? findAsset(workspace, activeTab.inputAssetId)
                  : null
              }
              inputAssetPublicUrl={
                activeTab.inputAssetId &&
                findAsset(workspace, activeTab.inputAssetId)?.role === "source"
                  ? workspace.sourceUrl
                  : null
              }
              inputAssetThumbUrl={activeInputThumb}
              prompt={activeTab.prompt}
              onPromptChange={(p) => patchTab(activeTab.id, { prompt: p })}
              onSave={handleAssetSave}
              onPreviewChange={(unsaved) => setTabUnsaved(activeTab.id, unsaved)}
            />
          )}

          {activeTab?.kind === "extract" && (
            <ExtractFrameTab
              folderName={folderName}
              externalRef={workspace.externalRef}
              inputVideo={
                activeTab.inputAssetId
                  ? findAsset(workspace, activeTab.inputAssetId)
                  : null
              }
              inputVideoUrl={activeInputThumb}
              scrubSeconds={activeTab.scrubSeconds}
              onScrubChange={(s) =>
                patchTab(activeTab.id, { scrubSeconds: s })
              }
              onSave={handleAssetSave}
            />
          )}

          {!activeTab && (
            <div className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-950 p-12 text-center text-sm text-neutral-500">
              No tab open — click <strong>+</strong> in the tab strip to start.
            </div>
          )}
        </div>

        <footer className="px-6 py-4 text-[10px] text-neutral-600">
          Working dir: Documents/{qdir(folderName, workspace.externalRef)}/
        </footer>
      </div>

      {settingsOpen && (
        <SettingsModal
          initial={settings}
          onClose={() => setSettingsOpen(false)}
          onSave={(next) => {
            saveSettings(next);
            setSettings(next);
          }}
        />
      )}
    </main>
  );
}

function formatRelative(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} h ago`;
}

export default App;
