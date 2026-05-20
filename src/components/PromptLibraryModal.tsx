// Prompt library modal — browse + apply saved prompts, or save the
// current draft. Hard-filtered by the active tab's kind (Wan animation
// prompts never show in a Flux image-edit context and vice-versa).
//
// Two modes share one shell: "browse" (search + list + apply/delete)
// and "save" (name the current draft, with an exact-duplicate warning).
// Opened in whichever mode the entry point implies — 📚 → browse,
// 💾 → save.

import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { Button, inputCls } from "./ui";
import {
  findDuplicate,
  suggestPromptName,
  type PromptKind,
  type SavedPrompt,
} from "../lib/prompt-library";

export function PromptLibraryModal({
  initialMode,
  kind,
  prompts,
  draftBody,
  onApply,
  onSaveNew,
  onUpdateExisting,
  onDelete,
  onClose,
}: {
  initialMode: "browse" | "save";
  /** Active tab's domain — filters the browse list and tags new saves. */
  kind: PromptKind;
  prompts: SavedPrompt[];
  /** The current prompt text, for save mode. Empty disables saving. */
  draftBody: string;
  onApply: (prompt: SavedPrompt) => void;
  onSaveNew: (name: string) => void;
  onUpdateExisting: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const [search, setSearch] = useState("");
  const [name, setName] = useState(() => suggestPromptName(draftBody));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const kindLabel = kind === "wan" ? "animation" : "image-edit";

  // Browse list — hard-filtered by kind, then search substring on
  // name + body, then sorted most-recent first.
  const q = search.trim().toLowerCase();
  const filtered = prompts
    .filter((p) => p.kind === kind)
    .filter(
      (p) =>
        q.length === 0 ||
        p.name.toLowerCase().includes(q) ||
        p.body.toLowerCase().includes(q),
    )
    .sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));

  const duplicate = draftBody.trim()
    ? findDuplicate(prompts, draftBody, kind)
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 pt-20"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[75vh] w-full max-w-2xl flex-col rounded-2xl border border-neutral-800 bg-neutral-950 shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">📚 Prompt library</h2>
            <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
              {kindLabel}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setMode("browse")}
              className={clsx(
                "rounded px-2 py-1 text-xs",
                mode === "browse"
                  ? "bg-neutral-800 text-white"
                  : "text-neutral-500 hover:text-neutral-200",
              )}
            >
              Browse
            </button>
            <button
              onClick={() => setMode("save")}
              disabled={!draftBody.trim()}
              title={
                draftBody.trim()
                  ? "Save the current prompt to the library"
                  : "Type a prompt first"
              }
              className={clsx(
                "rounded px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40",
                mode === "save"
                  ? "bg-neutral-800 text-white"
                  : "text-neutral-500 hover:text-neutral-200",
              )}
            >
              Save current
            </button>
            <button
              onClick={onClose}
              className="ml-1 rounded p-1 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
            >
              ×
            </button>
          </div>
        </header>

        {mode === "browse" ? (
          <>
            <div className="border-b border-neutral-800 p-3">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                placeholder={`Search ${kindLabel} prompts…`}
                className={inputCls}
                autoFocus
              />
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-3">
              {filtered.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs text-neutral-600">
                  {prompts.filter((p) => p.kind === kind).length === 0
                    ? `No saved ${kindLabel} prompts yet. Save one with 💾.`
                    : "No prompts match your search."}
                </p>
              ) : (
                filtered.map((p) => (
                  <div
                    key={p.id}
                    className="group rounded-lg border border-neutral-800 bg-neutral-900/40 p-3"
                  >
                    <div className="mb-1 flex items-start justify-between gap-2">
                      <p className="min-w-0 truncate text-sm font-medium text-neutral-200">
                        {p.name}
                      </p>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          onClick={() => onApply(p)}
                          className="rounded bg-indigo-600 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-white hover:bg-indigo-500"
                        >
                          Apply
                        </button>
                        <button
                          onClick={() => onDelete(p.id)}
                          title="Delete from library"
                          className="invisible flex h-6 w-6 items-center justify-center rounded text-neutral-600 hover:bg-rose-900/40 hover:text-rose-300 group-hover:visible"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                    <pre className="max-h-24 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-neutral-500">
                      {p.body}
                    </pre>
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto p-4">
            <label className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="e.g. Remove yellow arrows"
              className={inputCls}
              autoFocus
            />

            <p className="mt-4 mb-1 text-xs uppercase tracking-wide text-neutral-500">
              Prompt ({kindLabel})
            </p>
            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-neutral-800 bg-neutral-900 p-3 font-mono text-[11px] leading-relaxed text-neutral-300">
              {draftBody}
            </pre>

            {duplicate && (
              <div className="mt-4 rounded-lg border border-amber-900/40 bg-amber-950/20 p-3 text-xs text-amber-200">
                You already have <strong>"{duplicate.name}"</strong> with
                this exact prompt. Update it, or save anyway as a new
                entry.
              </div>
            )}

            <footer className="mt-5 flex items-center justify-end gap-3">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              {duplicate && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    onUpdateExisting(duplicate.id, name.trim() || duplicate.name);
                    onClose();
                  }}
                >
                  Update "{duplicate.name}"
                </Button>
              )}
              <Button
                onClick={() => {
                  onSaveNew(name.trim() || suggestPromptName(draftBody));
                  onClose();
                }}
                disabled={!draftBody.trim()}
              >
                {duplicate ? "Save as new" : "Save to library"}
              </Button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
