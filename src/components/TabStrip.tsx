// VSCode-style document tab strip. Each tab represents an open
// generation / extraction / trim / stitch document. The "+" dropdown
// adds a new tab; the × on each tab closes it.

import { clsx } from "clsx";
import { useRef, useState } from "react";
import type { PersistedTab } from "../lib/workspace";

export function TabStrip({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onNew,
  tabTitle,
}: {
  tabs: PersistedTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: (kind: "generate" | "extract" | "trim" | "stitch") => void;
  tabTitle: (tab: PersistedTab) => string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  return (
    // The outer flex row contains two siblings:
    // 1. A scrollable tab list (`overflow-x-auto`). Browsers can't mix
    //    `overflow-x: auto` with `overflow-y: visible` on the same
    //    element — the visible axis silently clamps to `auto`, so an
    //    absolutely-positioned dropdown inside this container would be
    //    clipped at the bottom edge of the strip.
    // 2. The "+ ▾" button + dropdown, as a sibling of the scroll
    //    container, so the dropdown can extend below the strip without
    //    getting clipped.
    <div className="flex items-stretch border-b border-neutral-800 bg-neutral-950">
      <div className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto px-2 py-1">
        {tabs.length === 0 && (
          <div className="flex items-center px-3 text-xs text-neutral-600">
            No tabs open · click <strong className="mx-1">+ New</strong> to start
          </div>
        )}

        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const title = tabTitle(tab);
          const icon =
            tab.kind === "generate"
              ? "🎬"
              : tab.kind === "extract"
                ? "✂️"
                : tab.kind === "trim"
                  ? "🎞️"
                  : "🔗";
          return (
            <div
              key={tab.id}
              className={clsx(
                "group flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                active
                  ? "bg-neutral-900 text-white"
                  : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200",
              )}
            >
              <button
                onClick={() => onActivate(tab.id)}
                className="flex items-center gap-2"
                title={title}
              >
                <span aria-hidden>{icon}</span>
                <span className="max-w-[16rem] truncate">{title}</span>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                title="Close tab"
                className="ml-1 flex h-5 w-5 items-center justify-center rounded text-neutral-600 hover:bg-rose-900/40 hover:text-rose-300"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <div className="relative shrink-0 py-1 pr-2" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="flex h-full items-center gap-1 rounded-md px-3 text-sm text-neutral-300 hover:bg-neutral-900 hover:text-white"
          title="New tab"
        >
          + New ▾
        </button>
        {menuOpen && (
          <div className="absolute right-2 top-full z-30 mt-1 min-w-48 rounded-lg border border-neutral-800 bg-neutral-950 py-1 shadow-xl">
            <MenuItem
              onSelect={() => {
                setMenuOpen(false);
                onNew("generate");
              }}
            >
              🎬 New Generate clip
            </MenuItem>
            <MenuItem
              onSelect={() => {
                setMenuOpen(false);
                onNew("extract");
              }}
            >
              ✂️ New Extract frame
            </MenuItem>
            <MenuItem
              onSelect={() => {
                setMenuOpen(false);
                onNew("trim");
              }}
            >
              🎞️ New Trim clip
            </MenuItem>
            <MenuItem
              onSelect={() => {
                setMenuOpen(false);
                onNew("stitch");
              }}
            >
              🔗 New Stitch clips
            </MenuItem>
          </div>
        )}
      </div>
    </div>
  );
}

function MenuItem({
  onSelect,
  children,
}: {
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onSelect}
      className="block w-full px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-900"
    >
      {children}
    </button>
  );
}
