import { useEffect, useRef, useState } from "react";
import { BaseDirectory, exists, remove } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  isLockedAsset,
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
  type ChatMessage,
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
import { TrimClipTab } from "./components/tabs/TrimClipTab";
import { StitchTab } from "./components/tabs/StitchTab";
import { TransformTab } from "./components/tabs/TransformTab";
import { SettingsModal } from "./components/SettingsModal";
import { ConfirmModal } from "./components/ConfirmModal";
import { OpenQuestionModal } from "./components/OpenQuestionModal";
import { ChatPanel } from "./components/ChatPanel";
import { AssetViewer } from "./components/AssetViewer";
import { PromptLibraryModal } from "./components/PromptLibraryModal";
import {
  addPrompt,
  deletePrompt,
  loadPromptLibrary,
  newPromptId,
  type PromptKind,
  type SavedPrompt,
} from "./lib/prompt-library";
import { Button, errorMessage, shorten } from "./components/ui";
import { loadSettings, saveSettings, type Settings } from "./lib/settings";
import { getQuestion, isRailsConnected } from "./lib/rails";

const DEFAULT_EXTERNAL_REF = "14";
const DEFAULT_SOURCE_URL =
  "https://hel1.your-objectstorage.com/gaiare-media/georgia/driving-tests/images/q14.jpg";

/** Generate tabs open with an empty prompt — the user authors the
 *  prompt via the AI chat panel (preferred) or types directly. The
 *  q14-specific scaffold prompt that used to live here was a stand-in
 *  for the chat assistant that didn't exist yet. */
const DEFAULT_PROMPT = "";

function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Reconcile the persisted Rails connection against the keychain on
  // startup: Settings (localStorage) can claim "connected" while the
  // keychain has no token (different machine, OS eviction). If so, clear
  // the stale flag so the UI doesn't advertise a dead connection.
  useEffect(() => {
    const server = settings.railsServer;
    if (!server) return;
    let cancelled = false;
    void isRailsConnected(server.url)
      .then((ok) => {
        if (cancelled || ok) return;
        setSettings((prev) => {
          const next = { ...prev, railsServer: undefined };
          saveSettings(next);
          return next;
        });
      })
      .catch(() => {
        /* keychain probe failed — leave state as-is */
      });
    return () => {
      cancelled = true;
    };
    // Mount-once reconciliation against the initial persisted settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  /** ID of the asset shown in the inspect viewer, or null if the
   *  viewer is closed. Kept on App rather than per-card local state so
   *  Esc / backdrop dismiss + keyboard navigation can be wired
   *  centrally without leaking modal state into the gallery. */
  const [viewerAssetId, setViewerAssetId] = useState<string | null>(null);

  /** Global reusable prompt library, loaded once at app start from
   *  `<folder>/prompt-library.json`. `lastUsedAt` is bumped in-memory
   *  on Apply (for sort recency) but only persisted on save/replace. */
  const [promptLibrary, setPromptLibrary] = useState<SavedPrompt[]>([]);
  const [libraryModal, setLibraryModal] = useState<{
    mode: "browse" | "save";
    kind: PromptKind;
    draftBody: string;
  } | null>(null);
  /** When set, renders a ConfirmModal. The `onConfirm` callback is the
   *  destructive action; setting back to `null` dismisses the modal. */
  const [confirm, setConfirm] = useState<{
    title: string;
    message: string | string[];
    confirmLabel?: string;
    cancelLabel?: string | null;
    destructive?: boolean;
    onConfirm: () => void | Promise<void>;
    /** Optional cleanup when the user dismisses without confirming
     *  (Cancel / Escape / backdrop). Used by the quit flow to tell
     *  Rust to clear its pending flag — otherwise QUIT_PENDING stays
     *  true and the next Cmd+Q is silently deduped away. */
    onCancel?: () => void | Promise<void>;
  } | null>(null);

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
        await refreshThumbnails(ws);
        // Prompt library is global (folder-scoped, not per-workspace)
        // so it loads once here and survives workspace switches.
        setPromptLibrary(await loadPromptLibrary(folderName));
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
  //
  // Indicator timing: the "saving…" pill only appears once the actual
  // write is in flight, NOT during the 500 ms debounce window. Earlier
  // we flashed it on every workspace state change, which painted a
  // continuous "saving…" while the user dragged the frame slider (each
  // tick is a state update); the indicator was lying because no write
  // was happening yet — only a pending timer.
  useEffect(() => {
    if (!bootstrapped || !workspace) return;
    const id = window.setTimeout(async () => {
      setSaveBlinker("saving");
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

  // Refs mirroring state, so the mount-once effects below can read the
  // CURRENT values from event callbacks without re-registering listeners
  // on every state change (which would have leak/duplicate-modal races
  // around the async `listen()` resolution).
  const confirmRef = useRef(confirm);
  const settingsOpenRef = useRef(settingsOpen);
  const newWorkspaceOpenRef = useRef(newWorkspaceOpen);
  const workspaceRef = useRef(workspace);
  // `closeTab` closes over `workspace` from its defining render. The
  // keyboard handler below is mount-once (empty deps), so without the
  // ref it'd call the very first `closeTab` — which captured a null
  // workspace and would early-return forever. Refreshing this ref each
  // render lets Cmd+W actually fire the latest version.
  const closeTabRef = useRef<(id: string) => void>(() => {});
  useEffect(() => {
    confirmRef.current = confirm;
  }, [confirm]);
  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);
  useEffect(() => {
    newWorkspaceOpenRef.current = newWorkspaceOpen;
  }, [newWorkspaceOpen]);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  // ─── Quit guard ───────────────────────────────────────────────────
  //
  // Two entry paths land here:
  //
  //  1. Red-dot window close → `tauri://close-requested` JS event,
  //     surfaced through `getCurrentWindow().onCloseRequested(...)`.
  //  2. ⌘Q / menu Quit / system quit on macOS → Rust emits
  //     `app-quit-requested` event from `on_menu_event` (and as a
  //     fallback from `RunEvent::ExitRequested`).
  //
  // Both funnel through `requestQuit()`. Real exit happens via the
  // `force_quit` Rust command which sets a Rust-side gate and calls
  // `app.exit(0)`. Calling `win.destroy()` would leave the app process
  // alive on macOS (default: closing the last window ≠ quit).
  //
  // The effect mounts ONCE. Earlier versions re-registered on every
  // state change which raced with the async `listen()` —
  // unlisten-leak + duplicate modals. Now the callback reads current
  // values from refs.
  useEffect(() => {
    const win = getCurrentWindow();

    function requestQuit() {
      // Stomp guard — if any modal is already open, drop the quit
      // request rather than overwriting it. The user is mid-decision;
      // they can press Cmd+Q again after.
      if (
        confirmRef.current ||
        settingsOpenRef.current ||
        newWorkspaceOpenRef.current
      ) {
        return;
      }
      setConfirm({
        title: "Quit Animation Studio?",
        message: [
          "The workspace is saved. You can pick it back up exactly where you left off next launch.",
        ],
        confirmLabel: "Quit",
        destructive: false,
        onConfirm: async () => {
          setConfirm(null);
          // Arm before force_quit — the Rust side refuses force_quit
          // unless armed within the last 10 s. This means a future
          // bug in a tab component invoking `force_quit` directly
          // can't bypass the confirm modal.
          try {
            await invoke("arm_quit");
            // Brief grace window so any in-flight `writeFile`
            // (e.g. a Wan download mid-write) can flush before the
            // Rust process exits — otherwise the mp4 ends up
            // truncated on disk and orphaned (no workspace.json
            // entry because `onSave` runs only after writeFile
            // returns). 300 ms is well below the threshold where
            // the user notices the pause.
            await new Promise((r) => setTimeout(r, 300));
            await invoke("force_quit");
          } catch (e) {
            console.error("[quit] force_quit failed", e);
          }
        },
        onCancel: async () => {
          // Tell Rust to clear QUIT_PENDING so the next Cmd+Q gesture
          // can open a fresh modal. Without this, dismissing → pressing
          // Cmd+Q again silently dedup's the second request.
          try {
            await invoke("cancel_quit");
          } catch (e) {
            console.error("[quit] cancel_quit failed", e);
          }
        },
      });
    }

    // Race-safe async unlisten registration. If the cleanup fires
    // before `.then` resolves, the resolved unlisten is called
    // immediately on the post-cleanup path.
    let unmounted = false;
    let unlistenClose: (() => void) | null = null;
    let unlistenQuit: (() => void) | null = null;

    void win
      .onCloseRequested((event) => {
        event.preventDefault();
        requestQuit();
      })
      .then((u) => {
        if (unmounted) u();
        else unlistenClose = u;
      });

    void listen("app-quit-requested", () => {
      requestQuit();
    }).then((u) => {
      if (unmounted) u();
      else unlistenQuit = u;
    });

    return () => {
      unmounted = true;
      unlistenClose?.();
      unlistenQuit?.();
    };
  }, []); // mount-once — refs supply current state

  // ─── Keyboard shortcuts ───────────────────────────────────────────
  //
  // VSCode-parity bindings. Cmd/Ctrl+W closes the active tab. Mounted
  // once; reads `workspace.activeTabId` via ref so we don't rebind on
  // every tab switch.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // Don't steal Cmd+W from open modals — the user is in a
      // confirm/settings/new-workspace flow and the shortcut should
      // be ignored rather than closing the underlying tab.
      if (
        confirmRef.current ||
        settingsOpenRef.current ||
        newWorkspaceOpenRef.current
      ) {
        return;
      }
      if (e.key === "w" || e.key === "W") {
        const activeId = workspaceRef.current?.activeTabId;
        if (!activeId) return;
        e.preventDefault();
        closeTabRef.current(activeId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // mount-once — refs supply current state

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
    if (loadResult) {
      await refetchMissingLocked(ws, loadResult.missingAssetIds);
    }
    ws = ensureAtLeastOneTab(ws);

    await adoptLock(ws.externalRef);

    setWorkspace(ws);
    await refreshThumbnails(ws);
  }

  // Re-download locked variants (enhanced / enhanced-safe) whose files
  // went missing on disk, using each asset's `remoteUrl`. Mirrors the
  // source asset's recovery, generalised to all locked assets.
  async function refetchMissingLocked(ws: Workspace, missingIds: string[]) {
    for (const id of missingIds) {
      const a = findAsset(ws, id);
      if (!a?.remoteUrl) continue;
      try {
        await downloadInto({
          folderName,
          externalRef: ws.externalRef,
          filename: a.filename,
          url: a.remoteUrl,
        });
      } catch {
        // Still unreachable — the missing-asset warning stands.
      }
    }
  }

  function newWorkspace() {
    setNewWorkspaceOpen(true);
  }

  async function createWorkspaceFromModal(args: {
    externalRef: string;
    sourceUrl: string;
    enhancedUrl?: string;
    enhancedSafeUrl?: string;
    questionId?: number;
  }) {
    clearWarnings();
    // Unified open: load the existing workspace (preserving prior work)
    // or create a fresh one, then idempotently ensure the source + the
    // enhanced variants are present. Re-opening a question therefore acts
    // as a "refresh" — missing locked images are pulled in without
    // clobbering anything (they're canonical, not user-generated).
    const existing = await loadWorkspace(folderName, args.externalRef);
    let ws = existing
      ? existing.workspace
      : makeEmptyWorkspace({
          externalRef: args.externalRef,
          sourceUrl: args.sourceUrl,
        });
    // Backfill a missing source URL from the question — repairs an
    // existing workspace that was created before the source was known
    // (e.g. manual entry with no URL), so re-opening it from the browser
    // fixes the source instead of leaving it blank forever.
    if (!ws.sourceUrl && args.sourceUrl) {
      ws = { ...ws, sourceUrl: args.sourceUrl };
    }
    await ensureWorkdir(folderName, ws.externalRef);
    ws = await ensureSourceAsset(ws);
    if (existing) {
      await refetchMissingLocked(ws, existing.missingAssetIds);
    }
    // Best-effort: present in the question's `images`, may 404 if the
    // enhance pipeline didn't run. addRemoteVariant skips if already there.
    ws = await addRemoteVariant(ws, args.enhancedUrl, "enhanced", "Enhanced");
    ws = await addRemoteVariant(
      ws,
      args.enhancedSafeUrl,
      "enhanced_safe",
      "Enhanced (safe)",
    );
    // Pull the question's correct signs from Rails (detail endpoint) so
    // sign-fix can auto-load references. Best-effort: skipped if not
    // connected or the question has no resolvable signs.
    if (args.questionId != null && settings.railsServer) {
      try {
        const detail = await getQuestion(
          settings.railsServer.url,
          String(args.questionId),
        );
        const signs = (detail.signs ?? [])
          .filter((s) => s.svg_url)
          .map((s) => ({ code: s.code, name: s.name, svgUrl: s.svg_url }));
        ws = { ...ws, questionSigns: signs };
      } catch {
        // best-effort — leave questionSigns as-is
      }
    }
    ws = ensureAtLeastOneTab(ws);

    await adoptLock(ws.externalRef);

    setWorkspace(ws);
    await refreshThumbnails(ws);

    if (existing && existing.missingAssetIds.length > 0) {
      pushWarning(
        `missing-${args.externalRef}`,
        `${existing.missingAssetIds.length} asset file(s) missing on disk for q${args.externalRef}.`,
      );
    }
  }

  // Download a locked image variant (enhanced / enhanced-safe) and add it
  // as a protected asset. 404 / unreachable → the variant doesn't exist,
  // skip silently. The `remoteUrl` lets it re-download if the file is lost.
  async function addRemoteVariant(
    ws: Workspace,
    url: string | undefined,
    role: "enhanced" | "enhanced_safe",
    label: string,
  ): Promise<Workspace> {
    if (!url) return ws;
    // Idempotent: a variant of this role already present → refresh no-op.
    if (ws.assets.some((a) => a.role === role)) return ws;
    try {
      const id = newAssetId();
      const extMatch = url.split("?")[0]!.match(/\.(png|jpe?g|webp)$/i);
      const ext = extMatch ? extMatch[1]!.toLowerCase().replace("jpeg", "jpg") : "jpg";
      const filename = generateAssetFilename({
        id,
        kind: "image",
        hint: "enhanced",
        ext,
      });
      await downloadInto({
        folderName,
        externalRef: ws.externalRef,
        filename,
        url,
      });
      const asset: Asset = {
        id,
        kind: "image",
        filename,
        label,
        role,
        remoteUrl: url,
        createdAt: Date.now(),
      };
      return upsertAsset(ws, asset);
    } catch {
      return ws;
    }
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

  async function handleAssetRename(id: string, label: string) {
    if (!workspace) return;
    const a = findAsset(workspace, id);
    if (!a) return;
    const next = upsertAsset(workspace, { ...a, label });
    setWorkspace(next);
    try {
      await saveWorkspace(folderName, next);
    } catch (e) {
      console.error("[workspace] rename save failed", e);
    }
  }

  function handleAssetDelete(id: string) {
    if (!workspace) return;
    const a = findAsset(workspace, id);
    if (!a) return;
    if (isLockedAsset(a)) {
      setConfirm({
        title: "Image is protected",
        message: [
          "This is a canonical image from Rails (source / enhanced) — it's locked and can't be deleted.",
          "If you need a different source, create a new workspace instead.",
        ],
        confirmLabel: "OK",
        cancelLabel: null,
        onConfirm: () => setConfirm(null),
      });
      return;
    }
    // Capture filename + externalRef NOW. By the time the user clicks
    // Confirm, the workspace state could have been replaced (e.g.
    // background autosave reload, switchWorkspace) and `findAsset`
    // would return null → filename "" → orphan file on disk while the
    // entry is pruned from the workspace.
    const filenameAtConfirmTime = a.filename;
    const externalRefAtConfirmTime = workspace.externalRef;
    setConfirm({
      title: "Delete asset?",
      message: [
        `"${a.label}" will be removed from the gallery and from disk.`,
        "This can't be undone.",
      ],
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: async () => {
        setConfirm(null);
        await performAssetDelete(id, filenameAtConfirmTime, externalRefAtConfirmTime);
      },
    });
  }

  async function performAssetDelete(
    id: string,
    filename: string,
    externalRef: string,
  ) {
    if (!workspace) return;
    const rel = relPathForAsset(folderName, externalRef, {
      id,
      filename,
    } as Asset);
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
      // Drop the deleted id from the tag queue too — otherwise its
      // slot would still consume a position in the array, shifting
      // later tagged cards' badge numbers off by one.
      taggedAssetIds: (next.taggedAssetIds ?? []).filter((x) => x !== id),
      tabs: next.tabs.map((t) => {
        // Stitch holds a list; drop every occurrence of the deleted id.
        if (t.kind === "stitch") {
          return {
            ...t,
            inputAssetIds: t.inputAssetIds.filter((x) => x !== id),
          };
        }
        return t.inputAssetId === id ? { ...t, inputAssetId: null } : t;
      }),
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
    // Close the inspect viewer if it was open on the just-deleted
    // asset. Without this the viewer's IIFE renders null (because
    // `findAsset` returns null), the modal disappears silently, but
    // `viewerAssetId` still references a ghost id — a future asset
    // with the same id would resurrect the modal.
    if (viewerAssetId === id) {
      setViewerAssetId(null);
    }
  }

  // ─── Tab operations ───────────────────────────────────────────────

  function selectAssetForActiveTab(assetId: string) {
    if (!workspace || !workspace.activeTabId) return;
    const a = findAsset(workspace, assetId);
    if (!a) return;
    const active = workspace.tabs.find((t) => t.id === workspace.activeTabId);
    if (!active) return;
    // Stitch is a multi-input tab — clicking a video appends to the
    // list rather than replacing a single-input slot. D&D from the
    // gallery achieves the same; click is the keyboard / trackpad
    // parity path.
    if (active.kind === "stitch") {
      if (a.kind !== "video") return;
      patchTab(active.id, {
        inputAssetIds: [...active.inputAssetIds, assetId],
      });
      return;
    }
    const wantsVideo = active.kind === "extract" || active.kind === "trim";
    const wantsImage = active.kind === "generate" || active.kind === "transform";
    if (
      (wantsImage && a.kind === "image") ||
      (wantsVideo && a.kind === "video")
    ) {
      patchTab(active.id, { inputAssetId: assetId });
    }
  }

  function pickIncompatibleAsset(assetId: string, kind: AssetKind) {
    if (!workspace) return;
    // Default behavior — open a "generate" tab for image inputs and an
    // "extract" tab for video inputs. Trim/stitch are opt-in via the
    // + dropdown.
    const tabKind: "generate" | "extract" =
      kind === "image" ? "generate" : "extract";
    openNewTab(tabKind, assetId);
  }

  function openNewTab(
    kind: "generate" | "extract" | "trim" | "stitch" | "transform",
    seedInputAssetId: string | null = null,
  ) {
    if (!workspace) return;
    const id = newTabId();
    const wantsVideoSeed =
      kind === "extract" || kind === "trim" || kind === "stitch";
    const seedAsset = seedInputAssetId
      ? findAsset(workspace, seedInputAssetId)
      : wantsVideoSeed
        ? workspace.assets.find((a) => a.kind === "video")
        : workspace.assets.find((a) => a.kind === "image" && a.role === "source");
    const inputAssetId = seedAsset?.id ?? null;

    let tab: PersistedTab;
    if (kind === "generate") {
      tab = { id, kind: "generate", inputAssetId, prompt: DEFAULT_PROMPT };
    } else if (kind === "extract") {
      tab = { id, kind: "extract", inputAssetId, scrubSeconds: null };
    } else if (kind === "trim") {
      tab = {
        id,
        kind: "trim",
        inputAssetId,
        trimStart: null,
        trimEnd: null,
      };
    } else if (kind === "stitch") {
      // Stitch — seed with the chosen asset if one was provided
      // (e.g. user clicked a video while no tab was active) so the
      // first slot is filled rather than greeting them with an
      // empty strip. Empty start is also fine.
      tab = {
        id,
        kind: "stitch",
        inputAssetIds: inputAssetId ? [inputAssetId] : [],
      };
    } else {
      // Transform — single-image input, empty prompt. User types the
      // edit instruction or has AI chat draft one.
      tab = { id, kind: "transform", inputAssetId, prompt: "" };
    }
    setWorkspace({
      ...workspace,
      tabs: [...workspace.tabs, tab],
      activeTabId: id,
    });
  }

  async function closeTab(id: string) {
    if (!workspace) return;
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
    // Persist now — tab closes are the most common "I'm done with this
    // train of thought" event and we want them to land before any
    // potential app crash.
    try {
      await saveWorkspace(folderName, next);
    } catch (e) {
      console.error("[workspace] immediate save after tab close failed", e);
    }
  }
  // Refresh the ref on every render so the mount-once Cmd+W handler
  // always invokes the latest `closeTab` (closure over current workspace).
  closeTabRef.current = closeTab;

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

  // ─── Asset tagging (for batch ops like Stitch append) ────────────

  // Functional setters throughout — the `T` key auto-repeats while held
  // and React batches state updates, so reading captured `workspace`
  // would lose toggles when two events fire before the first render
  // commits. `setWorkspace((prev) => ...)` always sees the freshest
  // state.

  function toggleAssetTag(id: string) {
    setWorkspace((ws) => {
      if (!ws) return ws;
      // Tagging is only meaningful for videos (Stitch is the only
      // consumer). Allowing image tags would create badges that
      // never produce a visible action — confusing.
      const asset = ws.assets.find((a) => a.id === id);
      if (asset?.kind !== "video") return ws;
      const current = ws.taggedAssetIds ?? [];
      const next = current.includes(id)
        ? current.filter((x) => x !== id)
        : [...current, id];
      return { ...ws, taggedAssetIds: next };
    });
  }

  function clearAssetTags() {
    setWorkspace((ws) => (ws ? { ...ws, taggedAssetIds: [] } : ws));
  }

  /** Append all tagged VIDEO assets (in order) to the active Stitch
   *  tab. No-op if there's no Stitch tab active. Tags are cleared
   *  after — they were a transient queue, not a long-lived label. */
  function appendTaggedToStitch() {
    setWorkspace((ws) => {
      if (!ws?.activeTabId) return ws;
      const active = ws.tabs.find((t) => t.id === ws.activeTabId);
      if (!active || active.kind !== "stitch") return ws;
      const taggedVideos = (ws.taggedAssetIds ?? []).filter((id) => {
        const a = ws.assets.find((x) => x.id === id);
        return a?.kind === "video";
      });
      if (taggedVideos.length === 0) return ws;
      return {
        ...ws,
        tabs: ws.tabs.map((t) =>
          t.id === active.id
            ? ({
                ...t,
                inputAssetIds: [...active.inputAssetIds, ...taggedVideos],
              } as PersistedTab)
            : t,
        ),
        taggedAssetIds: [],
      };
    });
  }

  // ─── AI chat ───────────────────────────────────────────────────────

  function appendChatMessage(msg: ChatMessage) {
    if (!workspace) return;
    setWorkspace({
      ...workspace,
      chat: [...(workspace.chat ?? []), msg],
    });
  }

  function applyPromptToActiveTab(prompt: string) {
    if (!workspace?.activeTabId) return;
    const active = workspace.tabs.find((t) => t.id === workspace.activeTabId);
    // Both prompt-bearing tab kinds accept an applied prompt.
    if (!active || (active.kind !== "generate" && active.kind !== "transform"))
      return;
    patchTab(active.id, { prompt });
  }

  // ─── Prompt library ──────────────────────────────────────────────

  /** Tab kind → library domain. Only generate (wan) + transform (flux)
   *  have prompts; other tabs return null and don't surface library
   *  affordances. */
  function libraryKindForActiveTab(): PromptKind | null {
    const active = workspace?.tabs.find((t) => t.id === workspace.activeTabId);
    if (active?.kind === "generate") return "wan";
    if (active?.kind === "transform") return "flux";
    return null;
  }

  function openLibrary(mode: "browse" | "save") {
    const kind = libraryKindForActiveTab();
    if (!kind || !workspace?.activeTabId) return;
    const active = workspace.tabs.find((t) => t.id === workspace.activeTabId);
    const draftBody =
      active && (active.kind === "generate" || active.kind === "transform")
        ? active.prompt
        : "";
    setLibraryModal({ mode, kind, draftBody });
  }

  /** Save the chat-proposed prompt directly (from ChatPanel's card)
   *  rather than the tab's current textarea — opens the save modal
   *  pre-loaded with that body. */
  function openLibrarySaveWithBody(body: string) {
    const kind = libraryKindForActiveTab();
    if (!kind) return;
    setLibraryModal({ mode: "save", kind, draftBody: body });
  }

  async function handleSaveNewPrompt(name: string) {
    if (!libraryModal) return;
    const prompt: SavedPrompt = {
      id: newPromptId(),
      name,
      body: libraryModal.draftBody,
      kind: libraryModal.kind,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    setPromptLibrary(await addPrompt(folderName, prompt));
  }

  async function handleUpdatePrompt(id: string, name: string) {
    if (!libraryModal) return;
    const existing = promptLibrary.find((p) => p.id === id);
    if (!existing) return;
    const updated: SavedPrompt = {
      ...existing,
      name,
      body: libraryModal.draftBody,
      lastUsedAt: Date.now(),
    };
    setPromptLibrary(await addPrompt(folderName, updated));
  }

  function handleApplyLibraryPrompt(prompt: SavedPrompt) {
    applyPromptToActiveTab(prompt.body);
    // Bump recency in memory only — persisting per-Apply would be the
    // noisiest cloud-sync trigger (architect note). Caveat: a
    // subsequent save/delete replaces state with the file contents
    // (which lack this bump), so within-session apply-recency can be
    // reset by an intervening save. That's a cosmetic sort effect, not
    // data loss — acceptable for a 3-user tool.
    setPromptLibrary((lib) =>
      lib.map((p) =>
        p.id === prompt.id ? { ...p, lastUsedAt: Date.now() } : p,
      ),
    );
    setLibraryModal(null);
  }

  async function handleDeleteLibraryPrompt(id: string) {
    setPromptLibrary(await deletePrompt(folderName, id));
  }

  function requestResetChat() {
    if (!workspace) return;
    const turns = workspace.chat?.length ?? 0;
    if (turns === 0) return;
    setConfirm({
      title: "Reset chat?",
      message: [
        `This wipes all ${turns} message${turns === 1 ? "" : "s"} in this workspace's chat.`,
        "Token cost so far stays on Fireworks' bill — the reset only affects local history. Start fresh with the same skills doc as context.",
      ],
      confirmLabel: "Reset",
      destructive: true,
      onConfirm: () => {
        setConfirm(null);
        // Functional setter: between confirm-open and confirm-click
        // the workspace state may have been replaced (autosave reload,
        // switchWorkspace, mid-flight chat append). Reading the
        // captured `workspace` would wipe chat on the stale shape and
        // clobber any tab/asset edits that landed in the meantime.
        setWorkspace((current) =>
          current ? { ...current, chat: [] } : current,
        );
      },
    });
  }

  function toggleChatPanel() {
    const next: Settings = {
      ...settings,
      chatPanelCollapsed: !settings.chatPanelCollapsed,
    };
    saveSettings(next);
    setSettings(next);
  }

  function tabTitle(tab: PersistedTab): string {
    // Contractor-set label always wins. Derived titles below are
    // fallbacks for when nothing has been customised.
    if (tab.userLabel?.trim()) {
      return shorten(tab.userLabel.trim(), 32);
    }
    if (tab.kind === "generate") {
      const firstLine = (tab.prompt ?? "").trim().split("\n")[0] ?? "";
      return shorten(firstLine, 28) || "New generate";
    }
    if (tab.kind === "stitch") {
      const n = tab.inputAssetIds.length;
      return n === 0
        ? "New stitch"
        : `Stitch ${n} clip${n === 1 ? "" : "s"}`;
    }
    const source = tab.inputAssetId
      ? findAsset(workspace!, tab.inputAssetId)
      : null;
    if (tab.kind === "transform") {
      const firstLine = (tab.prompt ?? "").trim().split("\n")[0] ?? "";
      const desc = shorten(firstLine, 22) || "edit";
      return source ? `Edit "${desc}" of ${shorten(source.label, 16)}` : "New edit";
    }
    if (tab.kind === "extract") {
      const s = tab.scrubSeconds ?? 0;
      return source
        ? `Extract @ ${s.toFixed(1)}s from ${shorten(source.label, 18)}`
        : "New extract";
    }
    // trim
    const a = tab.trimStart;
    const b = tab.trimEnd;
    if (source && a !== null && b !== null) {
      return `Trim ${a.toFixed(1)}–${b.toFixed(1)}s of ${shorten(source.label, 16)}`;
    }
    return source ? `Trim of ${shorten(source.label, 22)}` : "New trim";
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
  const activeKind: AssetKind =
    activeTab?.kind === "extract" ||
    activeTab?.kind === "trim" ||
    activeTab?.kind === "stitch"
      ? "video"
      : "image"; // generate + transform both consume images
  // Single-input tabs surface their pick to the gallery for highlight;
  // stitch is multi-input so no single selection is meaningful.
  const singleInputAssetId =
    activeTab && activeTab.kind !== "stitch" ? activeTab.inputAssetId : null;
  const activeInputThumb = singleInputAssetId
    ? thumbnailUrls[singleInputAssetId] ?? null
    : null;

  return (
    <main className="flex h-full bg-black text-neutral-200">
      <AssetGallery
        assets={workspace.assets}
        selectedAssetId={singleInputAssetId}
        onSelect={selectAssetForActiveTab}
        onRequestDelete={handleAssetDelete}
        onRename={handleAssetRename}
        activeKind={activeKind}
        onPickIncompatible={pickIncompatibleAsset}
        onPreview={setViewerAssetId}
        taggedAssetIds={workspace.taggedAssetIds ?? []}
        onToggleTag={toggleAssetTag}
        onClearTags={clearAssetTags}
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
          onActivate={activateTab}
          onClose={closeTab}
          onNew={openNewTab}
          tabTitle={tabTitle}
        />

        <div className="p-6">
          {activeTab?.kind === "generate" && (
            <GenerateClipTab
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
              onOpenLibrary={openLibrary}
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

          {activeTab?.kind === "trim" && (
            <TrimClipTab
              folderName={folderName}
              externalRef={workspace.externalRef}
              inputVideo={
                activeTab.inputAssetId
                  ? findAsset(workspace, activeTab.inputAssetId)
                  : null
              }
              inputVideoUrl={activeInputThumb}
              trimStart={activeTab.trimStart}
              trimEnd={activeTab.trimEnd}
              onTrimChange={(start, end) =>
                patchTab(activeTab.id, { trimStart: start, trimEnd: end })
              }
              onSave={handleAssetSave}
            />
          )}

          {activeTab?.kind === "stitch" && (
            <StitchTab
              folderName={folderName}
              externalRef={workspace.externalRef}
              workspace={workspace}
              inputAssetIds={activeTab.inputAssetIds}
              thumbnailUrls={thumbnailUrls}
              onChange={(next) =>
                patchTab(activeTab.id, { inputAssetIds: next })
              }
              onSave={handleAssetSave}
              taggedAssetIds={workspace.taggedAssetIds ?? []}
              onAppendTagged={appendTaggedToStitch}
            />
          )}

          {activeTab?.kind === "transform" && (
            <TransformTab
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
              onOpenLibrary={openLibrary}
              questionSigns={workspace.questionSigns ?? []}
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

      <ChatPanel
        folderName={folderName}
        workspace={workspace}
        activeTab={activeTab}
        onAppendMessage={appendChatMessage}
        onApplyPromptToActiveTab={applyPromptToActiveTab}
        onSavePromptToLibrary={openLibrarySaveWithBody}
        canSaveToLibrary={libraryKindForActiveTab() !== null}
        onResetChat={requestResetChat}
        collapsed={settings.chatPanelCollapsed ?? false}
        onToggleCollapsed={toggleChatPanel}
        width={settings.chatPanelWidth}
        onWidthChange={(next) => {
          const updated: Settings = { ...settings, chatPanelWidth: next };
          saveSettings(updated);
          setSettings(updated);
        }}
      />

      {settingsOpen && (
        <SettingsModal
          initial={settings}
          onClose={() => setSettingsOpen(false)}
          onSave={(next) => {
            saveSettings(next);
            setSettings(next);
          }}
          onRailsConnected={(server) => {
            const next = { ...settings, railsServer: server };
            saveSettings(next);
            setSettings(next);
          }}
          onRailsDisconnected={() => {
            const next = { ...settings, railsServer: undefined };
            saveSettings(next);
            setSettings(next);
          }}
        />
      )}

      {newWorkspaceOpen && (
        <OpenQuestionModal
          railsServer={settings.railsServer ?? null}
          defaultCountry={settings.defaultCountry}
          onOpen={createWorkspaceFromModal}
          onClose={() => setNewWorkspaceOpen(false)}
          onOpenSettings={() => {
            setNewWorkspaceOpen(false);
            setSettingsOpen(true);
          }}
        />
      )}

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          cancelLabel={confirm.cancelLabel}
          destructive={confirm.destructive}
          onConfirm={confirm.onConfirm}
          onClose={() => {
            const c = confirm;
            setConfirm(null);
            if (c?.onCancel) {
              try {
                void c.onCancel();
              } catch (e) {
                console.error("[confirm] onCancel threw", e);
              }
            }
          }}
        />
      )}

      {viewerAssetId &&
        (() => {
          const a = findAsset(workspace, viewerAssetId);
          if (!a) return null;
          return (
            <AssetViewer
              asset={a}
              thumbnailUrl={thumbnailUrls[a.id] ?? null}
              workspace={workspace}
              thumbnailUrls={thumbnailUrls}
              activeTabKind={activeTab?.kind ?? null}
              onClose={() => setViewerAssetId(null)}
              onUseAsInput={() => selectAssetForActiveTab(a.id)}
              onOpenInNewTab={() => pickIncompatibleAsset(a.id, a.kind)}
            />
          );
        })()}

      {libraryModal && (
        <PromptLibraryModal
          initialMode={libraryModal.mode}
          kind={libraryModal.kind}
          prompts={promptLibrary}
          draftBody={libraryModal.draftBody}
          onApply={handleApplyLibraryPrompt}
          onSaveNew={handleSaveNewPrompt}
          onUpdateExisting={handleUpdatePrompt}
          onDelete={handleDeleteLibraryPrompt}
          onClose={() => setLibraryModal(null)}
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
