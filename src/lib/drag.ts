// Shared drag-and-drop payload format.
//
// Both source types (gallery card and in-strip clip) share one MIME so
// the drop handler in `StitchTab` reads the payload once and branches
// on `source` — no fragile precedence between two MIME types.

export const DRAG_PAYLOAD_MIME = "application/x-drag-payload";

export type DragPayload =
  | { source: "gallery"; assetId: string }
  | { source: "strip"; index: number };

export function encodeDragPayload(p: DragPayload): string {
  return JSON.stringify(p);
}

/** Returns `null` if the dataTransfer doesn't carry our MIME or the
 *  payload doesn't parse — caller treats this as "not for us" and
 *  lets the browser do its default thing. */
export function readDragPayload(dataTransfer: DataTransfer): DragPayload | null {
  const raw = dataTransfer.getData(DRAG_PAYLOAD_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DragPayload;
    if (parsed.source === "gallery" && typeof parsed.assetId === "string") {
      return parsed;
    }
    if (parsed.source === "strip" && typeof parsed.index === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
