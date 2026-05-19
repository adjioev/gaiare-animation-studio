// New-workspace modal — replaces the back-to-back window.prompt() pair
// that previously asked for external_ref and source URL one at a time.
// Two prompts in a row felt frantic; a single inline form lets the
// contractor see both fields together and edit them before committing.

import { useEffect, useState } from "react";
import { Button, Field, errorMessage, inputCls } from "./ui";

export function NewWorkspaceModal({
  onSubmit,
  onClose,
}: {
  onSubmit: (args: {
    externalRef: string;
    sourceUrl: string;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [externalRef, setExternalRef] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  async function commit() {
    const ref = externalRef.trim();
    if (!ref) {
      setError("external_ref is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ externalRef: ref, sourceUrl: sourceUrl.trim() });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 pt-24"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl border border-neutral-800 bg-neutral-950 p-6 shadow-2xl"
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">New workspace</h2>
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200 disabled:opacity-40"
          >
            ×
          </button>
        </header>

        <section className="space-y-3">
          <Field
            label="external_ref"
            hint="The question id — e.g. 15 for q15"
          >
            <input
              type="text"
              value={externalRef}
              onChange={(e) => {
                setExternalRef(e.currentTarget.value);
                setError(null);
              }}
              placeholder="15"
              className={inputCls}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commit();
                }
              }}
            />
          </Field>

          <Field
            label="Source image URL"
            hint="Optional — leave empty to add later"
          >
            <input
              type="url"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.currentTarget.value)}
              placeholder="https://… (CDN, S3, etc.)"
              className={inputCls}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commit();
                }
              }}
            />
          </Field>

          <p className="text-xs text-neutral-500">
            Creates <code className="text-neutral-300">~/Documents/&lt;folder&gt;/q{externalRef.trim() || "…"}/</code>
            {" "}with the source image downloaded and one Generate tab seeded.
            You can change the source URL later by editing workspace.json
            directly.
          </p>

          {error && <p className="text-xs text-rose-300">⚠ {error}</p>}
        </section>

        <footer className="mt-6 flex items-center justify-end gap-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={commit} disabled={busy || !externalRef.trim()}>
            {busy ? "Creating…" : "Create workspace"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
