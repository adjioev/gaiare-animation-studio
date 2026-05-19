// Settings modal — currently exposes just the workspace folder name.
// Designed so we can grow it (per-app section, generation defaults,
// contractor identity) without redesigning the layout.

import { useEffect, useState } from "react";
import {
  DEFAULT_FOLDER_NAME,
  sanitizeFolderName,
  validateFolderName,
  type Settings,
} from "../lib/settings";
import { Button, Field, errorMessage, inputCls } from "./ui";

export function SettingsModal({
  initial,
  onSave,
  onClose,
}: {
  initial: Settings;
  onSave: (next: Settings) => Promise<void> | void;
  onClose: () => void;
}) {
  const [folderName, setFolderName] = useState(initial.workspaceFolderName);
  const [contractorId, setContractorId] = useState(initial.contractorId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function commit() {
    const cleaned = sanitizeFolderName(folderName);
    const err = validateFolderName(cleaned);
    if (err) {
      setError(err);
      return;
    }
    const trimmedContractor = contractorId.trim();
    setBusy(true);
    try {
      await onSave({
        workspaceFolderName: cleaned,
        contractorId: trimmedContractor || undefined,
      });
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
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl border border-neutral-800 bg-neutral-950 p-6 shadow-2xl"
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
          >
            ×
          </button>
        </header>

        <section className="space-y-3">
          <Field
            label="Workspace folder"
            hint={`Under ~/Documents · default "${DEFAULT_FOLDER_NAME}"`}
          >
            <input
              type="text"
              value={folderName}
              onChange={(e) => {
                setFolderName(e.currentTarget.value);
                setError(null);
              }}
              placeholder={DEFAULT_FOLDER_NAME}
              className={inputCls}
              autoFocus
            />
          </Field>
          <p className="text-xs text-neutral-500">
            All workspaces (q14, q15, …) live as subfolders inside this
            directory. Changing the folder name doesn't move existing files —
            it just switches which directory the app reads from. The path
            resolves to <code className="text-neutral-300">~/Documents/{folderName.trim() || DEFAULT_FOLDER_NAME}/</code>
            {" "}on macOS/Linux and <code className="text-neutral-300">{`%USERPROFILE%\\Documents\\${folderName.trim() || DEFAULT_FOLDER_NAME}\\`}</code> on Windows.
          </p>
          {error && (
            <p className="text-xs text-rose-300">⚠ {error}</p>
          )}

          <Field
            label="Contractor name"
            hint="Shown on workspace locks · advisory only"
          >
            <input
              type="text"
              value={contractorId}
              onChange={(e) => setContractorId(e.currentTarget.value)}
              placeholder="e.g. anna, dato, igor"
              className={inputCls}
            />
          </Field>
          <p className="text-xs text-neutral-500">
            When you open a workspace, this name is written to{" "}
            <code className="text-neutral-300">workspace.lock</code> so a
            teammate opening the same one sees a warning. Purely advisory —
            no authentication.
          </p>
        </section>

        <footer className="mt-6 flex items-center justify-end gap-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={commit} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
