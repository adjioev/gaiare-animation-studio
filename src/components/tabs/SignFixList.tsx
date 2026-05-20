// Sign-fix list — each row pairs ONE region (marked on the image) with
// ONE correct reference sign. Each pair is processed independently
// (crop → Gemini → composite), so the model never has to guess which
// reference belongs to which sign — the empirical reason this exists: a
// single whole-image call with several references placed a sign on the
// wrong post.
//
// The region itself is drawn on the shared SignRegionPicker; this list
// owns the references and which fix is currently being marked.

import { useState } from "react";
import { inputCls } from "../ui";
import type { Rect } from "./SignRegionPicker";

export type SignFix = {
  id: string;
  referenceUrl: string | null;
  region: Rect | null;
};

/** Stable palette so a fix's badge colour matches its rectangle on the
 *  picker. Indexed by the fix's position in the list. */
export const FIX_COLORS = [
  "#818cf8", // indigo
  "#34d399", // emerald
  "#fbbf24", // amber
  "#fb7185", // rose
  "#38bdf8", // sky
];

export function fixColor(index: number): string {
  return FIX_COLORS[index % FIX_COLORS.length];
}

/** Soft allowlist mirroring Rails `ALLOWED_SVG_HOSTS` — a nudge, not a
 *  hard block (the Tauri HTTP scope is the real gate). */
const ALLOWED_REF_HOST = /(^|\.)(wikimedia\.org|your-objectstorage\.com)$/;

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function FixRow({
  fix,
  index,
  active,
  onSetReference,
  onClearReference,
  onSelect,
  onRemove,
}: {
  fix: SignFix;
  index: number;
  active: boolean;
  onSetReference: (url: string) => void;
  onClearReference: () => void;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const [field, setField] = useState("");
  const color = fixColor(index);
  const trimmed = field.trim();
  const host = trimmed ? hostOf(trimmed) : null;
  const isValidUrl = host !== null;
  const untrusted = isValidUrl && !ALLOWED_REF_HOST.test(host);

  function add() {
    if (!isValidUrl) return;
    onSetReference(trimmed);
    setField("");
  }

  return (
    <li
      className="rounded-lg border bg-neutral-900 p-2"
      style={{ borderColor: active ? color : "#262626" }}
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-bold text-neutral-950"
          style={{ backgroundColor: color }}
        >
          {index + 1}
        </span>

        <div className="min-w-0 flex-1">
          {fix.referenceUrl ? (
            <div className="flex items-center gap-2">
              <img
                src={fix.referenceUrl}
                alt="reference sign"
                className="h-12 w-12 rounded border border-neutral-800 object-contain"
              />
              <span
                className="min-w-0 flex-1 truncate text-[11px] text-neutral-500"
                title={fix.referenceUrl}
              >
                {hostOf(fix.referenceUrl) ?? fix.referenceUrl}
              </span>
              <button
                onClick={onClearReference}
                className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-rose-300"
              >
                change
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                value={field}
                onChange={(e) => setField(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
                placeholder="https://upload.wikimedia.org/…/sign.svg"
                className={inputCls}
              />
              <button
                onClick={add}
                disabled={!isValidUrl}
                className="shrink-0 rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Add
              </button>
            </div>
          )}

          {trimmed && !isValidUrl && (
            <p className="mt-1 text-[11px] text-rose-300">Not a valid URL.</p>
          )}
          {untrusted && (
            <p className="mt-1 text-[11px] text-amber-300">
              ⚠ {host} isn't a known sign host — double-check the link.
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            onClick={onSelect}
            className="rounded px-2 py-1 text-[11px]"
            style={
              active
                ? { backgroundColor: color, color: "#0a0a0a" }
                : { color: "#a3a3a3" }
            }
            title="Draw this sign's region on the image"
          >
            {active ? "drawing…" : fix.region ? "re-mark" : "mark region"}
          </button>
          <span className="text-[10px] text-neutral-500">
            {fix.region ? "region set" : "no region"}
          </span>
          <button
            onClick={onRemove}
            title="Remove this fix"
            className="text-[11px] text-neutral-500 hover:text-rose-300"
          >
            remove
          </button>
        </div>
      </div>
    </li>
  );
}

export function SignFixList({
  fixes,
  activeId,
  onChange,
  onSelect,
}: {
  fixes: SignFix[];
  activeId: string | null;
  onChange: (next: SignFix[]) => void;
  onSelect: (id: string) => void;
}) {
  function update(id: string, patch: Partial<SignFix>) {
    onChange(fixes.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }
  function add() {
    const id = crypto.randomUUID();
    onChange([...fixes, { id, referenceUrl: null, region: null }]);
    onSelect(id);
  }

  return (
    <div className="space-y-2">
      {fixes.length > 0 && (
        <ul className="space-y-2">
          {fixes.map((fix, index) => (
            <FixRow
              key={fix.id}
              fix={fix}
              index={index}
              active={fix.id === activeId}
              onSetReference={(url) => update(fix.id, { referenceUrl: url })}
              onClearReference={() => update(fix.id, { referenceUrl: null })}
              onSelect={() => onSelect(fix.id)}
              onRemove={() => onChange(fixes.filter((f) => f.id !== fix.id))}
            />
          ))}
        </ul>
      )}
      <button
        onClick={add}
        className="rounded-lg border border-dashed border-neutral-700 px-3 py-1.5 text-[11px] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
      >
        + Add sign fix
      </button>
    </div>
  );
}
