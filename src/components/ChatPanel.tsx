// Right-side AI prompt-author chat. Lives outside any tab's render
// because the conversation is per-workspace, not per-tab — the user
// might iterate on the same animation idea across multiple Generate
// tabs (different start frames, different prompts) and the assistant
// should keep its memory.
//
// Display split into two regions: a scrollable transcript and an
// input area pinned to the bottom. Active-tab context flows in via
// props so the assistant grounds references to "the current prompt"
// against the right tab without us mirroring state.

import { useEffect, useRef, useState } from "react";
import { BaseDirectory, readFile } from "@tauri-apps/plugin-fs";
import {
  chat,
  estimateCostUsd,
  parseAssistantReply,
  SKILLS_FINGERPRINT,
  type ParsedReply,
} from "../lib/llm";
import {
  newChatMessageId,
  relPathForAsset,
  type Asset,
  type ChatMessage,
  type PersistedTab,
  type Workspace,
} from "../lib/workspace";
import { Button, errorMessage } from "./ui";
import { clsx } from "clsx";

/** Width bounds for the resize handle. Smaller than `MIN_WIDTH` makes
 *  bubbles cramped and the textarea unusable; wider than `MAX_WIDTH`
 *  starts eating into the main editor area on a 13" laptop. */
const MIN_WIDTH = 280;
const MAX_WIDTH = 700;
const DEFAULT_WIDTH = 384;

export function ChatPanel({
  folderName,
  workspace,
  activeTab,
  onAppendMessage,
  onApplyPromptToActiveTab,
  onResetChat,
  collapsed,
  onToggleCollapsed,
  width,
  onWidthChange,
}: {
  folderName: string;
  workspace: Workspace;
  activeTab: PersistedTab | undefined;
  /** Called each time the renderer wants to persist a chat turn — both
   *  the user's submission and the assistant's response. Parent batches
   *  them into the workspace's `chat` array and triggers the autosave. */
  onAppendMessage: (msg: ChatMessage) => void;
  /** Called when the user clicks "Apply to prompt" on a proposed
   *  prompt. Parent locates the currently-active generate tab and
   *  patches its `prompt` field. */
  onApplyPromptToActiveTab: (prompt: string) => void;
  /** Wipe the per-workspace chat history. Parent routes this through
   *  the shared ConfirmModal so the user has to acknowledge — once
   *  cleared the messages aren't recoverable. */
  onResetChat: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Persisted width when expanded. `undefined` falls back to default. */
  width?: number;
  /** Called once per resize gesture (mouseup) — parent persists. We
   *  deliberately don't call this on every mousemove to keep
   *  localStorage writes off the drag hot path. */
  onWidthChange?: (next: number) => void;
}) {
  const initialWidth = clampWidth(width ?? DEFAULT_WIDTH);
  const [panelWidth, setPanelWidth] = useState(initialWidth);
  // Track the latest width inside the drag handler without re-binding
  // mousemove on every render. mouseup reads the ref to persist.
  const panelWidthRef = useRef(initialWidth);
  panelWidthRef.current = panelWidth;

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;

    function cleanup() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }
    function onMove(ev: MouseEvent) {
      // If the mouseup escaped us (portal mounted mid-drag,
      // pointerlock, native menu) `buttons` drops to 0 — recover
      // gracefully instead of tracking the cursor forever.
      if (ev.buttons === 0) {
        cleanup();
        onWidthChange?.(panelWidthRef.current);
        return;
      }
      // Drag LEFT (delta > 0) widens the panel; drag right shrinks.
      const delta = startX - ev.clientX;
      setPanelWidth(clampWidth(startW + delta));
    }
    function onUp() {
      cleanup();
      onWidthChange?.(panelWidthRef.current);
    }

    // Prevent text selection / weird cursor flicker while dragging
    // across panel content.
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    // window blur fires if the user Cmd+Tabs away mid-drag — clean
    // up so we don't return to a panel still tracking the cursor.
    window.addEventListener("blur", onUp);
  }

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const history = workspace.chat ?? [];
  // Refs for `send()` to read freshest values without re-binding on
  // every render. Without `historyRef`, a rapid double-send would
  // capture the SAME pre-append history snapshot in both calls and
  // both turns would ship blind to each other; one would clobber the
  // other in workspace.json. `sendingRef` is the synchronous guard
  // that complements the async `setSending` state.
  const historyRef = useRef(history);
  historyRef.current = history;
  const sendingRef = useRef(false);

  // Auto-scroll to the bottom on new messages so the user sees the
  // latest reply without scrolling manually. Skips when the user has
  // scrolled up to read older context — checked by comparing the
  // scroll position to "near bottom".
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [history.length]);

  function snapshotTabContext(): ChatMessage["tabContext"] | undefined {
    if (!activeTab) return undefined;
    if (activeTab.kind === "generate") {
      return {
        tabKind: "generate",
        tabId: activeTab.id,
        prompt: activeTab.prompt,
        inputAssetLabel: inputLabel(activeTab, workspace),
      };
    }
    if (activeTab.kind === "extract" || activeTab.kind === "trim") {
      return {
        tabKind: activeTab.kind,
        tabId: activeTab.id,
        inputAssetLabel: inputLabel(activeTab, workspace),
      };
    }
    if (activeTab.kind === "stitch") {
      return {
        tabKind: "stitch",
        tabId: activeTab.id,
        inputAssetLabel: `${activeTab.inputAssetIds.length} clips in sequence`,
      };
    }
    return undefined;
  }

  async function send() {
    const trimmed = input.trim();
    // sendingRef is the SYNCHRONOUS guard — `sending` state is async
    // and a second ⌘↩ pressed before React flushes would slip through.
    if (!trimmed || sendingRef.current) return;
    sendingRef.current = true;
    setError(null);
    setSending(true);

    const userMsg: ChatMessage = {
      id: newChatMessageId(),
      role: "user",
      text: trimmed,
      tabContext: snapshotTabContext(),
      // Fingerprint lives only on assistant messages — the user
      // didn't author the skills doc, only the assistant turn was
      // driven by it. Keeps workspace.json bytes down and avoids the
      // confusing "the user message has a skills hash" smell.
      createdAt: Date.now(),
    };
    onAppendMessage(userMsg);
    setInput("");

    try {
      // Attach the active Generate tab's input image so the vision
      // model can actually see what Wan will animate. Skipped for
      // other tab kinds (no useful single image to show).
      const attachImageDataUri = await loadInputImageDataUri(
        folderName,
        workspace,
        activeTab,
      );
      // Read freshest history from the ref — between this function
      // being kicked off and now, another `setWorkspace` may have
      // committed (autosave reload, asset delete). Without the ref
      // we'd ship stale `history` from the earlier render closure.
      const res = await chat([...historyRef.current, userMsg], {
        attachImageDataUri: attachImageDataUri ?? undefined,
      });
      onAppendMessage({
        id: newChatMessageId(),
        role: "assistant",
        text: res.text,
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens,
        skillsFingerprint: SKILLS_FINGERPRINT,
        finishReason: res.finishReason,
        createdAt: Date.now(),
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  // Running cost estimate from token counts. Cheap to compute on
  // every render — the array is tiny.
  const totalUsd = history.reduce(
    (sum, m) =>
      sum + estimateCostUsd(m.promptTokens ?? 0, m.completionTokens ?? 0),
    0,
  );

  if (collapsed) {
    return (
      <button
        onClick={onToggleCollapsed}
        title="Open AI prompt author"
        className="flex w-10 shrink-0 flex-col items-center justify-start gap-2 border-l border-neutral-800 bg-neutral-950 pt-3 text-neutral-500 hover:text-neutral-200"
      >
        <span className="text-lg" aria-hidden>
          ✨
        </span>
        <span
          className="text-[10px]"
          style={{ writingMode: "vertical-rl", textOrientation: "mixed" }}
        >
          AI assist
        </span>
      </button>
    );
  }

  // Short suffix for the active-tab indicator: " · <asset label>" for
  // single-input tabs, " (N clips)" for stitch. Inlined here because
  // it was the only call site of the former `activeTabExtra` helper.
  const contextSuffix = activeTab
    ? activeTab.kind === "stitch"
      ? ` (${activeTab.inputAssetIds.length} clips)`
      : (() => {
          const label = inputLabel(activeTab, workspace);
          return label ? ` · ${label.slice(0, 28)}` : "";
        })()
    : "";

  return (
    <aside
      style={{ width: panelWidth }}
      className="relative flex shrink-0 flex-col border-l border-neutral-800 bg-neutral-950"
    >
      {/* Resize handle — a 4-px-wide vertical strip on the left edge.
          Idle: invisible against the existing border. Hover: faint
          indigo bar so the contractor finds it. Mouse leaves the
          handle still hits col-resize because we own the cursor on
          body during the drag (see startResize). */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className="absolute inset-y-0 -left-0.5 z-10 w-1 cursor-col-resize transition-colors hover:bg-indigo-500/60"
      />
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-semibold uppercase tracking-wider text-neutral-300">
            ✨ AI prompt author
          </span>
          <span className="truncate text-[10px] text-neutral-500">
            {activeTab
              ? `Context: ${activeTab.kind}${contextSuffix}`
              : "No tab open"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {history.length > 0 && (
            <button
              onClick={onResetChat}
              title="Reset chat — clears all messages in this workspace"
              className="rounded p-1 text-neutral-500 hover:bg-neutral-900 hover:text-rose-300"
            >
              ↺
            </button>
          )}
          <button
            onClick={onToggleCollapsed}
            title="Hide panel"
            className="rounded p-1 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
          >
            ›
          </button>
        </div>
      </header>

      <div
        ref={transcriptRef}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-3"
      >
        {history.length === 0 && (
          <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/40 p-4 text-xs text-neutral-500">
            <p className="mb-2">
              Describe the animation you want in plain language — the
              assistant will write a Wan prompt for you.
            </p>
            <p className="mb-2">After generation, tell it what went wrong:</p>
            <ul className="list-inside list-disc space-y-1 text-neutral-600">
              <li>"the car is flying"</li>
              <li>"camera keeps drifting right"</li>
              <li>"yellow van moved when it shouldn't have"</li>
            </ul>
          </div>
        )}
        {history.map((m) => (
          <Bubble
            key={m.id}
            message={m}
            onApply={onApplyPromptToActiveTab}
            canApply={activeTab?.kind === "generate"}
          />
        ))}
        {sending && (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3 text-xs text-neutral-500">
            Thinking…
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-rose-900/40 bg-rose-950/20 p-3 text-xs text-rose-300">
            ⚠ {error}
          </div>
        )}
      </div>

      <div className="border-t border-neutral-800 p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Describe what you want, or what went wrong…"
          rows={3}
          className="w-full resize-none rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-600"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[10px] text-neutral-600">
            ⌘↩ to send · session ≈ ${totalUsd.toFixed(3)}
          </span>
          <Button onClick={send} disabled={sending || !input.trim()}>
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </aside>
  );
}

function Bubble({
  message,
  onApply,
  canApply,
}: {
  message: ChatMessage;
  onApply: (prompt: string) => void;
  canApply: boolean;
}) {
  const isUser = message.role === "user";
  // Single-pass parse — same regex drives both the prompt extraction
  // and the reasoning/body slice, so the two can't drift.
  const parsed: ParsedReply = isUser
    ? { reasoning: message.text, prompt: null, body: "" }
    : parseAssistantReply(message.text);

  return (
    <div
      className={clsx(
        "rounded-xl px-3 py-2 text-sm leading-relaxed",
        isUser
          ? "border border-indigo-900/40 bg-indigo-950/20 text-neutral-200"
          : "border border-neutral-800 bg-neutral-900/40 text-neutral-300",
      )}
    >
      <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-600">
        {isUser ? "You" : "AI"}
      </div>
      <p className="whitespace-pre-wrap">{parsed.reasoning}</p>
      {parsed.prompt && (
        <div className="mt-3 rounded-lg border border-neutral-700 bg-neutral-950 p-2">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
            Proposed prompt
          </p>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-neutral-300">
            {parsed.prompt}
          </pre>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              onClick={() => navigator.clipboard.writeText(parsed.prompt!)}
              className="rounded border border-neutral-800 px-2 py-1 text-[10px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
            >
              Copy
            </button>
            <button
              onClick={() => onApply(parsed.prompt!)}
              disabled={!canApply}
              title={
                canApply
                  ? "Replace the active Generate tab's prompt"
                  : "Open a Generate tab to apply"
              }
              className="rounded bg-indigo-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-600"
            >
              Apply to prompt
            </button>
          </div>
        </div>
      )}
      {parsed.body && (
        <p className="mt-2 whitespace-pre-wrap text-xs text-neutral-500">
          {parsed.body}
        </p>
      )}
      {!isUser && message.finishReason && message.finishReason !== "stop" && (
        <p className="mt-2 text-[11px] text-amber-300/80">
          ⚠ Response cut off (
          <code className="text-amber-200">{message.finishReason}</code>
          ). Try asking again for a shorter answer, or re-send to continue.
        </p>
      )}
    </div>
  );
}

/** Read the active generate tab's input image off disk and return a
 *  `data:image/jpeg;base64,…` URI for embedding in a vision message.
 *  Returns null when the active tab isn't a Generate, has no input,
 *  or the file is missing — caller falls back to text-only chat. */
async function loadInputImageDataUri(
  folderName: string,
  workspace: Workspace,
  activeTab: PersistedTab | undefined,
): Promise<string | null> {
  if (!activeTab || activeTab.kind !== "generate") return null;
  const id = activeTab.inputAssetId;
  if (!id) return null;
  const asset = workspace.assets.find((a) => a.id === id);
  if (!asset || asset.kind !== "image") return null;
  try {
    const bytes = await readFile(
      relPathForAsset(folderName, workspace.externalRef, asset),
      { baseDir: BaseDirectory.Document },
    );
    return `data:${guessMime(asset)};base64,${bytesToBase64(bytes)}`;
  } catch (e) {
    console.warn("[chat] failed to read input image for attachment", e);
    return null;
  }
}

function guessMime(asset: Asset): string {
  const ext = asset.filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

/** btoa needs a Latin-1 binary string. JPEG/PNG bytes (0–255) survive
 *  `String.fromCharCode` because each byte maps to a single UTF-16
 *  code unit in [0, 255]. Source images are 30–200 KB — well below
 *  the argument-stack limit, no chunking needed. */
function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function inputLabel(
  tab: PersistedTab,
  workspace: Workspace,
): string | undefined {
  if (tab.kind === "stitch") return undefined;
  if (!tab.inputAssetId) return undefined;
  const a = workspace.assets.find((x) => x.id === tab.inputAssetId);
  return a?.label;
}

function clampWidth(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(n)));
}

