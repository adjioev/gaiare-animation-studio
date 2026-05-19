// Confirm/alert modal — replaces window.confirm() and window.alert().
// Tauri's native modal dialogs freeze the parent window on macOS and
// look out of place in the dark UI. This modal matches SettingsModal's
// chrome and supports either two-button (confirm) or one-button (alert)
// flavors via the `cancelLabel` prop.

import { useEffect, useRef } from "react";
import { Button } from "./ui";

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onClose,
}: {
  title: string;
  /** Single string or an array of paragraphs for multi-line messages. */
  message: string | string[];
  confirmLabel?: string;
  /** Pass `null` to render an "alert" with a single OK button. */
  cancelLabel?: string | null;
  /** Tint the confirm button rose for destructive actions (delete). */
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  /** Locks the modal to a single submission. Without this, mashing
   *  Enter or the Confirm button during an async `onConfirm` (e.g.
   *  delete that awaits FS work) would queue up duplicate invocations. */
  const submittingRef = useRef(false);

  async function trySubmit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      await onConfirm();
    } catch (e) {
      console.error("[confirm-modal] onConfirm threw — dismissing", e);
      // A thrown onConfirm would otherwise leave the modal stuck
      // forever (parent only calls setConfirm(null) on the happy
      // path). Force-close so the user isn't trapped.
      onClose();
    } finally {
      submittingRef.current = false;
    }
  }

  // Esc to close, Enter to confirm. Focus the confirm button on open so
  // keyboard users don't have to tab through.
  useEffect(() => {
    confirmBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (submittingRef.current) return;
      if (e.key === "Escape") onClose();
      if (e.key === "Enter") {
        e.preventDefault();
        void trySubmit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // trySubmit/onClose/onConfirm are not deps — we deliberately bind
    // once per modal mount; submittingRef gates re-entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const paragraphs = Array.isArray(message) ? message : [message];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 pt-32"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-950 p-6 shadow-2xl"
      >
        <header className="mb-3">
          <h2 className="text-base font-semibold">{title}</h2>
        </header>

        <div className="space-y-2 text-sm text-neutral-300">
          {paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>

        <footer className="mt-6 flex items-center justify-end gap-3">
          {cancelLabel !== null && (
            <Button variant="ghost" onClick={onClose}>
              {cancelLabel}
            </Button>
          )}
          <button
            ref={confirmBtnRef}
            onClick={() => void trySubmit()}
            className={
              destructive
                ? "rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-rose-500 disabled:opacity-50"
                : "rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-500 disabled:opacity-50"
            }
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
