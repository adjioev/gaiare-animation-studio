// Open-question modal — when connected to Rails, browse real questions
// and open one as a workspace (its image becomes the source). When not
// connected, falls back to the manual external_ref + URL entry (the old
// NewWorkspaceModal behaviour) plus a "Connect to Rails" shortcut.

import { useEffect, useState } from "react";
import {
  listCountries,
  listQuestions,
  type QuestionsPage,
  type StudioCountry,
  type StudioQuestion,
} from "../lib/rails";
import { Button, Field, errorMessage, inputCls } from "./ui";

const COGNITIVE_TYPES = [
  "textual",
  "situational",
  "procedural",
  "signquiz",
  "medical",
];

const PER_PAGE = 20;

export function OpenQuestionModal({
  railsServer,
  defaultCountry,
  onOpen,
  onClose,
  onOpenSettings,
}: {
  railsServer: { url: string } | null;
  defaultCountry?: string;
  onOpen: (args: {
    externalRef: string;
    sourceUrl: string;
    enhancedUrl?: string;
    enhancedSafeUrl?: string;
    questionId?: number;
  }) => Promise<void>;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 pt-16"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-4xl flex-col rounded-2xl border border-neutral-800 bg-neutral-950 p-6 shadow-2xl"
      >
        <header className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Open question</h2>
            {railsServer && (
              <p className="text-[11px] text-neutral-500">
                Connected to {railsServer.url}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200 disabled:opacity-40"
          >
            ×
          </button>
        </header>

        {railsServer ? (
          <BrowseQuestions
            serverUrl={railsServer.url}
            defaultCountry={defaultCountry}
            busy={busy}
            setBusy={setBusy}
            onOpen={onOpen}
            onClose={onClose}
            onOpenSettings={onOpenSettings}
          />
        ) : (
          <ManualEntry
            busy={busy}
            setBusy={setBusy}
            onOpen={onOpen}
            onClose={onClose}
            onOpenSettings={onOpenSettings}
          />
        )}
      </div>
    </div>
  );
}

function BrowseQuestions({
  serverUrl,
  defaultCountry,
  busy,
  setBusy,
  onOpen,
  onClose,
  onOpenSettings,
}: {
  serverUrl: string;
  defaultCountry?: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onOpen: (args: {
    externalRef: string;
    sourceUrl: string;
    enhancedUrl?: string;
    enhancedSafeUrl?: string;
    questionId?: number;
  }) => Promise<void>;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const [countries, setCountries] = useState<StudioCountry[]>([]);
  const [country, setCountry] = useState(defaultCountry ?? "");
  const [cognitiveType, setCognitiveType] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"updated" | "id">("updated");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<QuestionsPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authExpired, setAuthExpired] = useState(false);

  // Countries load once.
  useEffect(() => {
    let cancelled = false;
    listCountries(serverUrl)
      .then((c) => {
        if (!cancelled) setCountries(c);
      })
      .catch(() => {
        /* non-fatal — the filter just stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  // Debounce the search box into `query`.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Fetch the page whenever filters change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setAuthExpired(false);
    listQuestions(serverUrl, {
      country_code: country || undefined,
      cognitive_type: cognitiveType || undefined,
      q: query || undefined,
      page,
      per_page: PER_PAGE,
      sort,
    })
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((e) => {
        if (cancelled) return;
        const code = (e as { code?: string }).code;
        if (code === "rails_auth_expired") setAuthExpired(true);
        setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, country, cognitiveType, query, sort, page]);

  async function open(q: StudioQuestion) {
    setBusy(true);
    try {
      await onOpen({
        externalRef: q.external_ref,
        sourceUrl: q.image_url ?? "",
        enhancedUrl: q.images?.enhanced,
        enhancedSafeUrl: q.images?.enhanced_safe,
        questionId: q.id,
      });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const totalPages = result?.meta.total_pages ?? 1;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="text-xs">
          <span className="mb-1 block uppercase tracking-wide text-neutral-500">Country</span>
          <select
            value={country}
            onChange={(e) => {
              setCountry(e.currentTarget.value);
              setPage(1);
            }}
            className={inputCls}
          >
            <option value="">All</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.code})
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block uppercase tracking-wide text-neutral-500">Cognitive type</span>
          <select
            value={cognitiveType}
            onChange={(e) => {
              setCognitiveType(e.currentTarget.value);
              setPage(1);
            }}
            className={inputCls}
          >
            <option value="">All</option>
            {COGNITIVE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block uppercase tracking-wide text-neutral-500">Sort</span>
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.currentTarget.value as "updated" | "id");
              setPage(1);
            }}
            className={inputCls}
          >
            <option value="updated">Recently updated</option>
            <option value="id">Question id</option>
          </select>
        </label>
        <label className="flex-1 text-xs">
          <span className="mb-1 block uppercase tracking-wide text-neutral-500">Search</span>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.currentTarget.value)}
            placeholder="text…"
            className={inputCls}
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-neutral-800">
        {authExpired ? (
          <div className="p-8 text-center text-sm text-neutral-400">
            <p className="mb-3">Rails connection expired or was revoked.</p>
            <Button variant="secondary" onClick={onOpenSettings}>
              Reconnect to Rails
            </Button>
          </div>
        ) : loading ? (
          <div className="p-8 text-center text-sm text-neutral-500">Loading…</div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-rose-300">⚠ {error}</div>
        ) : !result || result.data.length === 0 ? (
          <div className="p-8 text-center text-sm text-neutral-500">
            No questions match your filters.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-900">
            {result.data.map((q) => (
              <li key={q.id}>
                <button
                  onClick={() => open(q)}
                  disabled={busy}
                  className="flex w-full items-center gap-3 p-3 text-left hover:bg-neutral-900 disabled:opacity-50"
                >
                  {q.image_url ? (
                    <img
                      src={q.image_url}
                      alt=""
                      loading="lazy"
                      className="h-14 w-20 shrink-0 rounded border border-neutral-800 object-cover"
                    />
                  ) : (
                    <div className="h-14 w-20 shrink-0 rounded border border-neutral-800 bg-neutral-900" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-neutral-300">
                        Q{q.external_ref}
                      </span>
                      <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-400">
                        {q.cognitive_type}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-sm text-neutral-300">
                      {q.text ?? "—"}
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="mt-3 flex items-center justify-between text-xs text-neutral-500">
        <span>{result ? `${result.meta.total} total` : ""}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            className="rounded border border-neutral-700 px-2 py-1 disabled:opacity-40"
          >
            Prev
          </button>
          <span>
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= totalPages || loading}
            className="rounded border border-neutral-700 px-2 py-1 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </footer>
    </>
  );
}

function ManualEntry({
  busy,
  setBusy,
  onOpen,
  onClose,
  onOpenSettings,
}: {
  busy: boolean;
  setBusy: (b: boolean) => void;
  onOpen: (args: {
    externalRef: string;
    sourceUrl: string;
    enhancedUrl?: string;
    enhancedSafeUrl?: string;
    questionId?: number;
  }) => Promise<void>;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const [externalRef, setExternalRef] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function commit() {
    const ref = externalRef.trim();
    if (!ref) {
      setError("external_ref is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onOpen({ externalRef: ref, sourceUrl: sourceUrl.trim() });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 text-[11px] text-neutral-400">
        Not connected to Rails — enter a question manually, or{" "}
        <button
          onClick={onOpenSettings}
          className="text-indigo-400 underline hover:text-indigo-300"
        >
          connect to Rails
        </button>{" "}
        to browse questions.
      </div>

      <Field label="external_ref" hint="The question id — e.g. 15 for q15">
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
      <Field label="Source image URL" hint="Optional — leave empty to add later">
        <input
          type="url"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.currentTarget.value)}
          placeholder="https://… (CDN, S3, etc.)"
          className={inputCls}
        />
      </Field>

      {error && <p className="text-xs text-rose-300">⚠ {error}</p>}

      <div className="flex items-center justify-end gap-3 pt-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={commit} disabled={busy || !externalRef.trim()}>
          {busy ? "Creating…" : "Create workspace"}
        </Button>
      </div>
    </section>
  );
}
