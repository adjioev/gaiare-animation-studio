import { useCallback, useEffect, useState } from "react";
import { claimJob, listJobs, releaseJob, type StudioJob } from "../lib/rails";
import { errorMessage } from "./ui";

type Tab = "open" | "mine";

/** The studio work queue: pull/claim open jobs, open + manage claimed ones.
 *  Polls on open and on manual refresh — desktop app, no push needed. */
export function JobsPanel({
  serverUrl,
  open,
  onClose,
  onOpenJob,
}: {
  serverUrl: string;
  open: boolean;
  onClose: () => void;
  onOpenJob: (job: StudioJob) => void;
}) {
  const [tab, setTab] = useState<Tab>("open");
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setJobs(await listJobs(serverUrl, tab));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [serverUrl, tab]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  if (!open) return null;

  async function claim(job: StudioJob) {
    setBusyId(job.id);
    setError(null);
    try {
      await claimJob(serverUrl, job.id);
    } catch {
      // Almost always a 409 race (someone claimed first). Show a friendly note
      // rather than the raw error; the refresh below drops the taken job.
      setError("Couldn't claim — it may have just been taken. Queue refreshed.");
    } finally {
      setBusyId(null);
      await refresh();
    }
  }

  async function release(job: StudioJob) {
    setBusyId(job.id);
    setError(null);
    try {
      await releaseJob(serverUrl, job.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
      await refresh();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border border-neutral-700 bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-100">Work queue</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-200">
            ✕
          </button>
        </div>

        <div className="flex gap-1 border-b border-neutral-800 px-4 pt-2">
          {(["open", "mine"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-t px-3 py-1.5 text-sm ${
                tab === t
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {t === "open" ? "Queue" : "My jobs"}
            </button>
          ))}
          <button
            onClick={() => void refresh()}
            className="ml-auto self-center text-xs text-neutral-400 hover:text-neutral-200"
          >
            Refresh
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error && (
            <div className="mb-2 rounded bg-rose-900/40 px-3 py-2 text-xs text-rose-200">{error}</div>
          )}
          {loading ? (
            <p className="text-sm text-neutral-500">Loading…</p>
          ) : jobs.length === 0 ? (
            <p className="text-sm text-neutral-500">
              {tab === "open" ? "No open jobs in the queue." : "You haven't claimed any jobs."}
            </p>
          ) : (
            <ul className="space-y-2">
              {jobs.map((job) => (
                <li
                  key={job.id}
                  className="flex items-center gap-3 rounded-lg border border-neutral-800 p-2"
                >
                  {job.question_image_url ? (
                    <img
                      src={job.question_image_url}
                      alt=""
                      className="h-10 w-14 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <div className="h-10 w-14 shrink-0 rounded bg-neutral-800" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-neutral-200">Q{job.question_external_ref}</p>
                    {job.brief && <p className="truncate text-xs text-neutral-500">{job.brief}</p>}
                  </div>
                  {tab === "open" ? (
                    <button
                      disabled={busyId === job.id}
                      onClick={() => void claim(job)}
                      className="rounded-md bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
                    >
                      {busyId === job.id ? "…" : "Claim"}
                    </button>
                  ) : (
                    <div className="flex gap-1">
                      <button
                        onClick={() => {
                          onOpenJob(job);
                          onClose();
                        }}
                        className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600"
                      >
                        Open
                      </button>
                      <button
                        disabled={busyId === job.id}
                        onClick={() => void release(job)}
                        className="rounded-md px-2 py-1.5 text-sm text-neutral-400 hover:bg-neutral-800 disabled:opacity-50"
                      >
                        Release
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
