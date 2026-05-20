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
  cognitive_type: string;
  topic: string | null;
  subtopic: string | null;
  updated_at: string | null;
};

export type StudioCountry = { code: string; name: string };

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
