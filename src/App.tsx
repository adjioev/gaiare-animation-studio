import { useEffect, useState } from "react";
import { BaseDirectory, exists, remove } from "@tauri-apps/plugin-fs";
import "./App.css";
import {
  asset as resolveAsset,
  downloadInto,
  ensureWorkdir,
  qdir,
} from "./lib/workdir";
import { Q14_PRESETS } from "./lib/promptTemplates";
import {
  findAsset,
  generateAssetFilename,
  listWorkspaces,
  loadWorkspace,
  makeEmptyWorkspace,
  newAssetId,
  readLastWorkspaceRef,
  relPathForAsset,
  removeAsset,
  saveWorkspace,
  upsertAsset,
  type Asset,
  type AssetKind,
  type Workspace,
} from "./lib/workspace";
import { AssetGallery } from "./components/AssetGallery";
import { GenerateClipTab } from "./components/tabs/GenerateClipTab";
import { ExtractFrameTab } from "./components/tabs/ExtractFrameTab";
import { Button, errorMessage } from "./components/ui";

const DEFAULT_EXTERNAL_REF = "14";
const DEFAULT_SOURCE_URL =
  "https://hel1.your-objectstorage.com/gaiare-media/georgia/driving-tests/images/q14.jpg";

type TabId = "generate" | "extract";

const TABS: Array<{ id: TabId; label: string; assetKind: AssetKind }> = [
  { id: "generate", label: "Generate clip", assetKind: "image" },
  { id: "extract", label: "Extract frame", assetKind: "video" },
];

function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [availableWorkspaces, setAvailableWorkspaces] = useState<
    Array<{ externalRef: string; updatedAt: number }>
  >([]);
  const [saveBlinker, setSaveBlinker] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [activeTab, setActiveTab] = useState<TabId>("generate");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>(
    {},
  );
  const [globalError, setGlobalError] = useState<string | null>(null);

  // ─── Lifecycle ────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      try {
        const list = await listWorkspaces();
        setAvailableWorkspaces(list);

        const lastRef = await readLastWorkspaceRef();
        const candidate =
          lastRef ?? list[0]?.externalRef ?? DEFAULT_EXTERNAL_REF;
        let ws = await loadWorkspace(candidate);
        if (!ws) {
          ws = makeEmptyWorkspace({
            externalRef: candidate,
            sourceUrl: candidate === DEFAULT_EXTERNAL_REF ? DEFAULT_SOURCE_URL : "",
          });
        }
        // Make sure the source image asset exists for new workspaces.
        ws = await ensureSourceAsset(ws);
        setWorkspace(ws);
        await refreshThumbnails(ws);
        // Auto-select a sensible default for the active tab.
        autoSelect(ws, activeTab);
      } catch (e) {
        setGlobalError(errorMessage(e));
      } finally {
        setBootstrapped(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave whenever workspace changes (after bootstrap).
  useEffect(() => {
    if (!bootstrapped || !workspace) return;
    setSaveBlinker("saving");
    const id = window.setTimeout(async () => {
      try {
        await saveWorkspace(workspace);
        setSaveBlinker("saved");
        setAvailableWorkspaces(await listWorkspaces());
        window.setTimeout(() => setSaveBlinker("idle"), 1200);
      } catch (e) {
        console.error("[workspace] save failed", e);
        setSaveBlinker("idle");
      }
    }, 500);
    return () => window.clearTimeout(id);
  }, [bootstrapped, workspace]);

  // ─── Workspace operations ─────────────────────────────────────────

  async function switchWorkspace(externalRef: string) {
    const loaded = await loadWorkspace(externalRef);
    const ws = loaded ?? makeEmptyWorkspace({ externalRef, sourceUrl: "" });
    const ready = await ensureSourceAsset(ws);
    setWorkspace(ready);
    await refreshThumbnails(ready);
    autoSelect(ready, activeTab);
  }

  async function newWorkspace() {
    const ref = window.prompt("New workspace — external_ref (e.g. 15):");
    if (!ref?.trim()) return;
    const url = window.prompt("Source image URL (CDN, leave empty to set later):");
    const ws = makeEmptyWorkspace({
      externalRef: ref.trim(),
      sourceUrl: url?.trim() ?? "",
    });
    const ready = await ensureSourceAsset(ws);
    setWorkspace(ready);
    await refreshThumbnails(ready);
    autoSelect(ready, activeTab);
  }

  /**
   * Download the workspace's `sourceUrl` to disk and register it as the
   * first image asset, if it isn't already in `workspace.assets`.
   */
  async function ensureSourceAsset(ws: Workspace): Promise<Workspace> {
    if (!ws.sourceUrl) return ws;
    const existing = ws.assets.find((a) => a.role === "source");
    if (existing) return ws;
    try {
      await ensureWorkdir(ws.externalRef);
      const id = newAssetId();
      const filename = generateAssetFilename({
        id,
        kind: "image",
        hint: "source",
      });
      await downloadInto({
        externalRef: ws.externalRef,
        filename,
        url: ws.sourceUrl,
      });
      const asset: Asset = {
        id,
        kind: "image",
        filename,
        label: "Source",
        role: "source",
        createdAt: Date.now(),
      };
      return upsertAsset(ws, asset);
    } catch (e) {
      console.warn("[workspace] failed to fetch source image:", e);
      return ws;
    }
  }

  async function refreshThumbnails(ws: Workspace) {
    const next: Record<string, string> = {};
    for (const asset of ws.assets) {
      const rel = relPathForAsset(ws.externalRef, asset);
      try {
        next[asset.id] = await resolveAsset(rel);
      } catch {
        // skip unresolvable
      }
    }
    setThumbnailUrls(next);
  }

  function autoSelect(ws: Workspace, tab: TabId) {
    const need = TABS.find((t) => t.id === tab)!.assetKind;
    const candidate = ws.assets.find((a) => a.kind === need);
    setSelectedAssetId(candidate?.id ?? null);
  }

  // When the user switches tabs, clear the selection if it's no longer
  // compatible with the new tab's required asset kind.
  function changeTab(next: TabId) {
    setActiveTab(next);
    if (!workspace) return;
    const need = TABS.find((t) => t.id === next)!.assetKind;
    const current = selectedAssetId
      ? findAsset(workspace, selectedAssetId)
      : null;
    if (!current || current.kind !== need) {
      autoSelect(workspace, next);
    }
  }

  async function handleAssetSave(newAsset: Asset) {
    if (!workspace) return;
    const next = upsertAsset(workspace, newAsset);
    setWorkspace(next);
    await refreshThumbnails(next);
  }

  async function handleAssetDelete(id: string) {
    if (!workspace) return;
    const asset = findAsset(workspace, id);
    if (!asset) return;
    if (asset.role === "source") {
      // Belt + suspenders — the gallery hides the delete button on the
      // source card, but block in the data path too so any future
      // programmatic delete (keyboard shortcut, batch ops) can't strip
      // the workspace of its starting image.
      window.alert(
        "The source image is protected — it's the workspace anchor.\nIf you really want to swap it, create a new workspace.",
      );
      return;
    }
    const ok = window.confirm(
      `Delete "${asset.label}"?\n\nThe file will be removed from disk.`,
    );
    if (!ok) return;

    const rel = relPathForAsset(workspace.externalRef, asset);
    try {
      if (await exists(rel, { baseDir: BaseDirectory.Document })) {
        await remove(rel, { baseDir: BaseDirectory.Document });
      }
    } catch (e) {
      console.warn("[workspace] file delete failed; pruning from workspace anyway", e);
    }
    const next = removeAsset(workspace, id);
    setWorkspace(next);
    setThumbnailUrls((prev) => {
      const { [id]: _gone, ...rest } = prev;
      return rest;
    });
    if (selectedAssetId === id) {
      autoSelect(next, activeTab);
    }
  }

  function handlePickIncompatible(id: string, kind: AssetKind) {
    // Clicking a card in the "wrong" section flips the active tab to
    // the one that consumes that asset's kind, then selects it. This
    // makes the genealogy "this clip was generated from that image →
    // click image to use it again" navigation work in one tap.
    const targetTab = TABS.find((t) => t.assetKind === kind);
    if (!targetTab) return;
    setActiveTab(targetTab.id);
    setSelectedAssetId(id);
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
      <main className="p-6 text-sm text-rose-300">
        Fatal: {globalError}
      </main>
    );
  }

  const selectedAsset = workspace && selectedAssetId
    ? findAsset(workspace, selectedAssetId)
    : null;
  const activeTabSpec = TABS.find((t) => t.id === activeTab)!;
  const selectedThumb = selectedAsset
    ? thumbnailUrls[selectedAsset.id] ?? null
    : null;

  return (
    <main className="flex h-full bg-black text-neutral-200">
      <AssetGallery
        assets={workspace?.assets ?? []}
        selectedAssetId={selectedAssetId}
        onSelect={setSelectedAssetId}
        onRequestDelete={handleAssetDelete}
        activeKind={activeTabSpec.assetKind}
        onPickIncompatible={handlePickIncompatible}
        thumbnailUrls={thumbnailUrls}
      />

      <div className="min-w-0 flex-1 overflow-y-auto">
        {/* Top bar */}
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-neutral-800 bg-black/95 px-6 py-3 backdrop-blur">
          <h1 className="text-sm font-semibold tracking-tight">
            Gaiare Animation Studio
          </h1>
          <span className="text-xs text-neutral-600">·</span>
          <span className="text-xs text-neutral-500">
            q{workspace?.externalRef}
          </span>

          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-neutral-600">Workspace</span>
            <select
              value={workspace?.externalRef ?? ""}
              onChange={(e) => switchWorkspace(e.currentTarget.value)}
              className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200"
            >
              {availableWorkspaces.length === 0 && workspace && (
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

        {/* Tabs */}
        <nav className="flex gap-1 border-b border-neutral-800 px-6">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => changeTab(tab.id)}
              className={
                "border-b-2 px-4 py-3 text-sm transition-colors " +
                (activeTab === tab.id
                  ? "border-indigo-500 text-white"
                  : "border-transparent text-neutral-500 hover:text-neutral-300")
              }
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Tab content */}
        <div className="p-6">
          {activeTab === "generate" && workspace && (
            <GenerateClipTab
              externalRef={workspace.externalRef}
              selectedImage={
                selectedAsset?.kind === "image" ? selectedAsset : null
              }
              selectedImagePublicUrl={
                selectedAsset?.kind === "image" &&
                selectedAsset.label === "Source"
                  ? workspace.sourceUrl
                  : null
              }
              selectedImageThumbUrl={selectedThumb}
              defaultPrompt={Q14_PRESETS.clip1}
              onSave={handleAssetSave}
            />
          )}

          {activeTab === "extract" && workspace && (
            <ExtractFrameTab
              externalRef={workspace.externalRef}
              selectedVideo={
                selectedAsset?.kind === "video" ? selectedAsset : null
              }
              selectedVideoUrl={selectedThumb}
              onSave={handleAssetSave}
            />
          )}
        </div>

        <footer className="px-6 py-4 text-[10px] text-neutral-600">
          Working dir: ~/Documents/{workspace ? qdir(workspace.externalRef) : "?"}/
        </footer>
      </div>
    </main>
  );
}

export default App;
