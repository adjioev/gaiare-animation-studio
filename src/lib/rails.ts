// Rails Studio API client. Thin TS wrappers over the Rust proxy
// commands (src-tauri/src/rails.rs) which hold the bearer token in the
// OS keychain — the token never reaches this JS bundle except the once,
// when the user pastes it into `connectRails`.
//
// Every call takes the server URL (stored non-secret in Settings); Rust
// resolves the matching token from the keychain.

import { invoke } from "@tauri-apps/api/core";

export type StudioQuestion = {
  id: number;
  external_ref: string;
  country_code: string | null;
  text: string | null;
  image_url: string | null;
  /** Candidate URLs for the image variants (Hetzner path convention).
   *  Keys present only when derivable; each may still 404 (enhance
   *  pipeline didn't run for this question) — fetch and skip on failure. */
  images?: {
    original?: string;
    enhanced?: string;
    enhanced_safe?: string;
  };
  cognitive_type: string;
  topic: string | null;
  subtopic: string | null;
  updated_at: string | null;
  /** Correct signs for the question — only on the detail (show) response,
   *  resolved from the question's visual context. */
  signs?: StudioSign[];
};

export type StudioCountry = { code: string; name: string };

/** An artwork proposal (enhanced image / video) submitted back to Rails
 *  for admin review. */
export type StudioSubmission = {
  id: number;
  question_id: number;
  kind: "enhanced_image" | "video";
  status: "proposed" | "approved" | "rejected";
  s3_url: string;
  note: string | null;
  reject_reason: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
};

/** A correct sign for a question (detail/show only), for the sign-fix
 *  flow. `svg_url` is the canonical reference to repaint from. */
export type StudioSign = {
  code: string;
  name: string | null;
  svg_url: string;
  image_url: string | null;
};

export type QuestionFilters = {
  country_code?: string;
  cognitive_type?: string;
  q?: string;
  page?: number;
  per_page?: number;
  /** "updated" (default, most-recent first) or "id" (numeric external_ref). */
  sort?: "updated" | "id";
};

export type QuestionsMeta = {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
};

export type QuestionsPage = { data: StudioQuestion[]; meta: QuestionsMeta };

/** Rust rejects with this shape; `code` lets callers branch (e.g. show a
 *  "Reconnect" CTA on `rails_auth_expired`). */
export type RailsError = { code: string; message: string };

export function isRailsError(e: unknown): e is RailsError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as RailsError).code === "string" &&
    typeof (e as RailsError).message === "string"
  );
}

export const DEFAULT_RAILS_URL = "http://localhost:3011";

/** Validate a pasted token against the server and store it in the
 *  keychain. Throws a RailsError on failure (nothing persisted). */
export async function connectRails(serverUrl: string, token: string): Promise<void> {
  await invoke("rails_connect", { serverUrl, token });
}

export async function disconnectRails(serverUrl: string): Promise<void> {
  await invoke("rails_disconnect", { serverUrl });
}

export async function isRailsConnected(serverUrl: string): Promise<boolean> {
  return invoke<boolean>("rails_is_connected", { serverUrl });
}

export async function listCountries(serverUrl: string): Promise<StudioCountry[]> {
  const res = await invoke<{ data: StudioCountry[] }>("rails_list_countries", {
    serverUrl,
  });
  return res.data;
}

export async function listQuestions(
  serverUrl: string,
  filters: QuestionFilters,
): Promise<QuestionsPage> {
  return invoke<QuestionsPage>("rails_list_questions", {
    serverUrl,
    query: filters,
  });
}

export async function getQuestion(
  serverUrl: string,
  idOrComposite: string,
): Promise<StudioQuestion> {
  const res = await invoke<{ data: StudioQuestion }>("rails_get_question", {
    serverUrl,
    id: idOrComposite,
  });
  return res.data;
}

/** List a question's artwork proposals (newest first) — what's already
 *  been submitted for review and each one's status. */
export async function listSubmissions(
  serverUrl: string,
  questionId: number,
): Promise<StudioSubmission[]> {
  const res = await invoke<{ data: StudioSubmission[] }>(
    "rails_list_submissions",
    { serverUrl, questionId: String(questionId) },
  );
  return res.data;
}

/** Upload a finished artwork (image/video) as a `proposed` submission for
 *  a question. `filePath` is an absolute path inside the user's Documents
 *  folder; the bytes go through the Rust proxy (token stays server-side). */
export async function submitArtifact(args: {
  serverUrl: string;
  questionId: number;
  kind: "enhanced_image" | "video";
  filePath: string;
  note?: string;
  jobId?: number;
}): Promise<StudioSubmission> {
  const res = await invoke<{ data: StudioSubmission }>("rails_submit_artifact", {
    serverUrl: args.serverUrl,
    questionId: String(args.questionId),
    kind: args.kind,
    filePath: args.filePath,
    note: args.note ?? null,
    jobId: args.jobId ?? null,
  });
  return res.data;
}

/** A unit of artwork work an admin requested. Designers pull these from the
 *  shared queue, claim one, and deliver via submitArtifact (with jobId). */
export type StudioJob = {
  id: number;
  question_id: number;
  question_external_ref: string;
  question_image_url: string | null;
  brief: string | null;
  status: string;
};

/** The shared work queue: "open" (claimable) or "mine" (claimed by me). */
export async function listJobs(
  serverUrl: string,
  status: "open" | "mine",
): Promise<StudioJob[]> {
  const res = await invoke<{ data: StudioJob[] }>("rails_list_jobs", {
    serverUrl,
    query: { status },
  });
  return res.data;
}

/** Claim an open job. Throws a RailsError on a race (Rails replies 409 when the
 *  job was just taken); the caller refreshes the queue to drop it. */
export async function claimJob(serverUrl: string, id: number): Promise<StudioJob> {
  const res = await invoke<{ data: StudioJob }>("rails_claim_job", {
    serverUrl,
    id: String(id),
  });
  return res.data;
}

/** Release a claimed job back to the queue. */
export async function releaseJob(serverUrl: string, id: number): Promise<StudioJob> {
  const res = await invoke<{ data: StudioJob }>("rails_release_job", {
    serverUrl,
    id: String(id),
  });
  return res.data;
}
