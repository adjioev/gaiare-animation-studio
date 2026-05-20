// Drag-rectangle picker over the source image, multi-region.
//
// Each "sign fix" owns one region; this picker renders ALL fixes' regions
// as coloured, numbered overlays and lets the user (re)draw the region of
// the currently-selected fix. Spatial placement is OUR job, not the
// model's: each region is later cropped, sent to Gemini with ONE matching
// reference, and composited back at its own coordinates — so the model
// never has to guess which sign goes where.
//
// Regions are reported in NORMALISED 0–1 fractions of the image, not
// pixels. Resolution-independent — survives cropping a thumbnail vs the
// full-res source, and matches the shape GS-13's Rails bbox arrives in.

import { useRef, useState } from "react";

/** Region as fractions of the image, origin top-left. All in [0,1]. */
export type Rect = { x: number; y: number; w: number; h: number };

export type PickerRegion = {
  id: string;
  rect: Rect;
  color: string;
  label: string;
};

/** Illustrative margin ring around the active region — communicates that
 *  a small surround is sent to Gemini for background matching. Real
 *  padding is computed in pixels at crop time (backend phase). */
const PADDING_FRAC = 0.03;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function rectFromDrag(
  a: { x: number; y: number },
  b: { x: number; y: number },
): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

export function SignRegionPicker({
  imageUrl,
  regions,
  activeId,
  activeColor,
  onDraw,
}: {
  imageUrl: string;
  /** Committed regions for every fix that has one. */
  regions: PickerRegion[];
  /** Fix whose region a drag edits. `null` = no fix selected (drawing
   *  disabled until the user adds/selects a fix). */
  activeId: string | null;
  activeColor: string;
  onDraw: (next: Rect | null) => void;
}) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);

  function fracFromEvent(e: React.PointerEvent): { x: number; y: number } {
    const el = overlayRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - r.left) / r.width),
      y: clamp01((e.clientY - r.top) / r.height),
    };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!activeId) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = fracFromEvent(e);
    setStart(p);
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!start) return;
    setDraft(rectFromDrag(start, fracFromEvent(e)));
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!start) return;
    const r = rectFromDrag(start, fracFromEvent(e));
    setStart(null);
    setDraft(null);
    onDraw(r.w > 0.01 && r.h > 0.01 ? r : null);
  }

  const activeRect =
    draft ?? regions.find((r) => r.id === activeId)?.rect ?? null;
  const padded = activeRect
    ? {
        x: clamp01(activeRect.x - PADDING_FRAC),
        y: clamp01(activeRect.y - PADDING_FRAC),
        w: Math.min(
          1 - clamp01(activeRect.x - PADDING_FRAC),
          activeRect.w + PADDING_FRAC * 2,
        ),
        h: Math.min(
          1 - clamp01(activeRect.y - PADDING_FRAC),
          activeRect.h + PADDING_FRAC * 2,
        ),
      }
    : null;

  return (
    <div className="relative inline-block max-w-full select-none">
      <img
        src={imageUrl}
        alt="source"
        draggable={false}
        className="block max-h-[55vh] w-auto max-w-full rounded-lg border border-neutral-800"
      />
      <div
        ref={overlayRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={
          "absolute inset-0 " + (activeId ? "cursor-crosshair" : "cursor-default")
        }
      >
        {/* Committed regions for non-active fixes (read-only). */}
        {regions
          .filter((r) => !(draft && r.id === activeId))
          .map((r) => (
            <div
              key={r.id}
              className="pointer-events-none absolute rounded-sm border-2"
              style={{
                left: pct(r.rect.x),
                top: pct(r.rect.y),
                width: pct(r.rect.w),
                height: pct(r.rect.h),
                borderColor: r.color,
                backgroundColor: r.color + "22",
              }}
            >
              <span
                className="absolute -left-1 -top-3 rounded px-1 text-[10px] font-bold text-neutral-950"
                style={{ backgroundColor: r.color }}
              >
                {r.label}
              </span>
            </div>
          ))}

        {/* Active region margin ring. */}
        {padded && (
          <div
            className="pointer-events-none absolute rounded-sm border border-dashed"
            style={{
              left: pct(padded.x),
              top: pct(padded.y),
              width: pct(padded.w),
              height: pct(padded.h),
              borderColor: activeColor + "99",
            }}
          />
        )}

        {/* Active region (draft while dragging, else committed). */}
        {activeRect && (
          <div
            className="pointer-events-none absolute rounded-sm border-2"
            style={{
              left: pct(activeRect.x),
              top: pct(activeRect.y),
              width: pct(activeRect.w),
              height: pct(activeRect.h),
              borderColor: activeColor,
              backgroundColor: activeColor + "26",
            }}
          />
        )}

        {!activeId && regions.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded bg-neutral-950/70 px-2 py-1 text-[11px] text-neutral-300">
              Add a sign fix, then drag here to mark it
            </span>
          </div>
        )}
        {activeId && !activeRect && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded bg-neutral-950/70 px-2 py-1 text-[11px] text-neutral-300">
              Drag to mark sign
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
