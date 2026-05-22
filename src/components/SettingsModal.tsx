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
import { DEFAULT_RAILS_URL, connectRails, disconnectRails } from "../lib/rails";
import {
  SECRET_FIELDS,
  clearSecret,
  secretStatus,
  setSecret,
  type SecretKey,
} from "../lib/secrets";

export function SettingsModal({
  initial,
  onSave,
  onClose,
  onRailsConnected,
  onRailsDisconnected,
}: {
  initial: Settings;
  onSave: (next: Settings) => Promise<void> | void;
  onClose: () => void;
  onRailsConnected: (server: { url: string }) => void;
  onRailsDisconnected: () => void;
}) {
  const [folderName, setFolderName] = useState(initial.workspaceFolderName);
  const [contractorId, setContractorId] = useState(initial.contractorId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"general" | "keys">("general");

  // Rails connection (paste-token). The token goes straight to the Rust
  // keychain via connectRails — it's never kept in component state beyond
  // the input, never persisted to Settings/localStorage.
  const [connectedUrl, setConnectedUrl] = useState<string | null>(
    initial.railsServer?.url ?? null,
  );
  const [serverUrl, setServerUrl] = useState(
    initial.railsServer?.url ?? DEFAULT_RAILS_URL,
  );
  const [tokenInput, setTokenInput] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);

  // API keys (Replicate / Gemini / Fireworks) — stored in the OS keychain via
  // the Rust commands; the value never round-trips back to JS, only set/not-set.
  const [keyStatus, setKeyStatus] = useState<Record<SecretKey, boolean>>({
    replicate: false,
    gemini: false,
    fireworks: false,
  });
  const [keyInputs, setKeyInputs] = useState<Record<SecretKey, string>>({
    replicate: "",
    gemini: "",
    fireworks: "",
  });
  const [keyBusy, setKeyBusy] = useState<SecretKey | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        SECRET_FIELDS.map(async (f) => [f.key, await secretStatus(f.key)] as const),
      );
      if (!cancelled) {
        setKeyStatus(Object.fromEntries(entries) as Record<SecretKey, boolean>);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveKey(key: SecretKey) {
    const value = keyInputs[key].trim();
    if (!value) return;
    setKeyBusy(key);
    setKeyError(null);
    try {
      await setSecret(key, value);
      setKeyInputs((s) => ({ ...s, [key]: "" }));
      setKeyStatus((s) => ({ ...s, [key]: true }));
    } catch (e) {
      setKeyError(errorMessage(e));
    } finally {
      setKeyBusy(null);
    }
  }

  async function clearKey(key: SecretKey) {
    setKeyBusy(key);
    setKeyError(null);
    try {
      await clearSecret(key);
      setKeyStatus((s) => ({ ...s, [key]: false }));
    } catch (e) {
      setKeyError(errorMessage(e));
    } finally {
      setKeyBusy(null);
    }
  }

  async function connect() {
    const url = serverUrl.trim().replace(/\/+$/, "");
    const token = tokenInput.trim();
    if (!url || !token) {
      setConnError("Server URL and token are required.");
      return;
    }
    setConnecting(true);
    setConnError(null);
    try {
      await connectRails(url, token);
      setConnectedUrl(url);
      setTokenInput("");
      onRailsConnected({ url });
    } catch (e) {
      setConnError(errorMessage(e));
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    if (!connectedUrl) return;
    setConnecting(true);
    setConnError(null);
    try {
      await disconnectRails(connectedUrl);
      setConnectedUrl(null);
      onRailsDisconnected();
    } catch (e) {
      setConnError(errorMessage(e));
    } finally {
      setConnecting(false);
    }
  }

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
        ...initial,
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

        <nav className="mb-4 flex gap-1 border-b border-neutral-800">
          {([["general", "General"], ["keys", "API keys"]] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
                tab === id
                  ? "border-white text-white"
                  : "border-transparent text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        <section className="space-y-3">
          {tab === "general" && (
          <>
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

          <div className="border-t border-neutral-800 pt-4">
            <p className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
              Rails connection
            </p>
            {connectedUrl ? (
              <div className="space-y-2">
                <p className="text-sm text-neutral-200">
                  Connected to{" "}
                  <code className="text-neutral-300">{connectedUrl}</code>
                </p>
                <Button
                  variant="secondary"
                  onClick={disconnect}
                  disabled={connecting}
                >
                  {connecting ? "…" : "Disconnect"}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <Field label="Server URL">
                  <input
                    type="url"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.currentTarget.value)}
                    placeholder={DEFAULT_RAILS_URL}
                    className={inputCls}
                  />
                </Field>
                <Field label="API token" hint="from Rails /admin/api_tokens">
                  <input
                    type="password"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.currentTarget.value)}
                    placeholder="paste token"
                    className={inputCls}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void connect();
                      }
                    }}
                  />
                </Field>
                <Button onClick={connect} disabled={connecting || !tokenInput.trim()}>
                  {connecting ? "Connecting…" : "Connect"}
                </Button>
              </div>
            )}
            {connError && (
              <p className="mt-2 text-xs text-rose-300">⚠ {connError}</p>
            )}
            <p className="mt-2 text-[11px] text-neutral-500">
              The token is stored in your macOS Keychain — never on disk in
              plain text. Generate one in Rails admin → API tokens.
            </p>
          </div>
          </>
          )}

          {tab === "keys" && (
          <div>
            <p className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
              API keys
            </p>
            <div className="space-y-3">
              {SECRET_FIELDS.map((f) => (
                <div key={f.key}>
                  <Field label={f.label} hint={f.hint}>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={keyInputs[f.key]}
                        onChange={(e) =>
                          setKeyInputs((s) => ({ ...s, [f.key]: e.currentTarget.value }))
                        }
                        placeholder={keyStatus[f.key] ? "•••••• (paste to replace)" : f.placeholder}
                        className={inputCls}
                      />
                      <Button
                        onClick={() => saveKey(f.key)}
                        disabled={keyBusy === f.key || !keyInputs[f.key].trim()}
                      >
                        {keyBusy === f.key ? "…" : "Save"}
                      </Button>
                    </div>
                  </Field>
                  <div className="mt-1 flex items-center gap-2 text-[11px]">
                    {keyStatus[f.key] ? (
                      <>
                        <span className="text-emerald-400">✓ set</span>
                        <button
                          onClick={() => clearKey(f.key)}
                          disabled={keyBusy === f.key}
                          className="text-neutral-500 hover:text-rose-300 disabled:opacity-50"
                        >
                          clear
                        </button>
                      </>
                    ) : (
                      <span className="text-neutral-500">not set</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {keyError && <p className="mt-2 text-xs text-rose-300">⚠ {keyError}</p>}
            <p className="mt-2 text-[11px] text-neutral-500">
              Stored in your OS keychain — never bundled in the app or written to
              disk in plain text.
            </p>
          </div>
          )}
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
