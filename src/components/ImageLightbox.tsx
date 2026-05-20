// Full-screen zoomable image viewer. Opened to inspect details the
// gallery / tab previews are too small to show (e.g. a mangled road sign
// before marking its region). Wheel or +/- to zoom, drag to pan when
// zoomed, double-click to toggle fit↔2.5×, Esc / backdrop / × to close.

import { useEffect, useRef, useState } from "react";

const MIN_SCALE = 1;
const MAX_SCALE = 8;

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const dragRef = useRef<{
    x: number;
    y: number;
    tx: number;
    ty: number;
  } | null>(null);

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

  function reset() {
    setScale(1);
    setTx(0);
    setTy(0);
  }

  function zoomBy(factor: number) {
    setScale((prev) => {
      const next = clampScale(prev * factor);
      if (next === 1) {
        setTx(0);
        setTy(0);
      }
      return next;
    });
  }

  function onWheel(e: React.WheelEvent) {
    // Pan-zoom around the centre — simple and predictable. Prevent the
    // page from scrolling underneath.
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }

  function onPointerDown(e: React.PointerEvent) {
    if (scale === 1) return; // nothing to pan at fit
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, tx, ty };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    setTx(d.tx + (e.clientX - d.x));
    setTy(d.ty + (e.clientY - d.y));
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/95"
      onClick={onClose}
    >
      {/* Toolbar */}
      <div
        className="absolute right-4 top-4 z-10 flex items-center gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => zoomBy(1 / 1.4)}
          className="h-8 w-8 rounded-lg border border-neutral-700 bg-neutral-900/80 text-neutral-200 hover:border-neutral-500"
          title="Zoom out"
        >
          −
        </button>
        <span className="min-w-[3rem] text-center text-xs text-neutral-400">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => zoomBy(1.4)}
          className="h-8 w-8 rounded-lg border border-neutral-700 bg-neutral-900/80 text-neutral-200 hover:border-neutral-500"
          title="Zoom in"
        >
          +
        </button>
        <button
          onClick={reset}
          className="h-8 rounded-lg border border-neutral-700 bg-neutral-900/80 px-3 text-xs text-neutral-200 hover:border-neutral-500"
          title="Reset zoom"
        >
          Reset
        </button>
        <button
          onClick={onClose}
          className="h-8 w-8 rounded-lg border border-neutral-700 bg-neutral-900/80 text-neutral-200 hover:border-neutral-500"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>

      {/* Image stage */}
      <div
        className="flex h-full w-full items-center justify-center overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => (scale === 1 ? zoomBy(2.5) : reset())}
        style={{ cursor: scale > 1 ? "grab" : "zoom-in" }}
      >
        <img
          src={src}
          alt={alt ?? "image"}
          draggable={false}
          className="max-h-full max-w-full select-none object-contain"
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transformOrigin: "center center",
          }}
        />
      </div>
    </div>
  );
}
