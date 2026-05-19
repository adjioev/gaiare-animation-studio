// Replicate API client — runs in the renderer process for the MVP. The
// API token is read from Vite env (`REPLICATE_API_TOKEN` from the local
// `.env`) and ends up baked into the client bundle, which is fine for a
// personal dev tool but unacceptable once we ship installer builds to
// contractors. Production migration target: proxy these calls through
// `next-server` so the token stays server-side.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const REPLICATE_BASE = "https://api.replicate.com/v1";

function token(): string {
  // Vite exposes any var matching the prefixes declared in vite.config.ts.
  const t = import.meta.env.REPLICATE_API_TOKEN as string | undefined;
  if (!t) {
    throw new Error(
      "REPLICATE_API_TOKEN missing from .env (Vite envPrefix includes 'REPLICATE_').",
    );
  }
  return t;
}

type PredictionStatus =
  | "starting"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled";

export type Prediction<TOutput = unknown> = {
  id: string;
  status: PredictionStatus;
  output?: TOutput;
  error?: string | null;
  urls: { get: string; cancel: string };
  metrics?: { predict_time?: number };
};

async function http<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const url = path.startsWith("http") ? path : `${REPLICATE_BASE}${path}`;
  const res = await tauriFetch(url, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Token ${token()}`,
      "Content-Type": "application/json",
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "<no body>");
    throw new Error(`Replicate ${res.status}: ${txt}`);
  }
  return (await res.json()) as T;
}

/**
 * Start a prediction on a public Replicate model. Returns immediately
 * with the prediction id; call `pollPrediction` to wait for output.
 */
export async function createPrediction<TInput, TOutput>(args: {
  modelOwner: string;
  modelName: string;
  input: TInput;
}): Promise<Prediction<TOutput>> {
  return http<Prediction<TOutput>>(
    `/models/${args.modelOwner}/${args.modelName}/predictions`,
    { method: "POST", body: { input: args.input } },
  );
}

/**
 * Poll a running prediction until it succeeds or fails. Resolves with
 * the final prediction record; the caller is responsible for handling
 * `failed` / `canceled` statuses.
 */
export async function pollPrediction<TOutput>(
  prediction: Prediction<TOutput>,
  opts: { intervalMs?: number; timeoutMs?: number; onTick?: (p: Prediction<TOutput>) => void } = {},
): Promise<Prediction<TOutput>> {
  const interval = opts.intervalMs ?? 1500;
  const timeout = opts.timeoutMs ?? 180_000;
  const started = Date.now();
  let current = prediction;

  while (current.status !== "succeeded" && current.status !== "failed" && current.status !== "canceled") {
    if (Date.now() - started > timeout) {
      throw new Error(`Prediction ${current.id} timed out after ${timeout} ms`);
    }
    await new Promise((r) => setTimeout(r, interval));
    current = await http<Prediction<TOutput>>(current.urls.get);
    opts.onTick?.(current);
  }
  return current;
}

// ─── Wan 2.2 i2v fast ──────────────────────────────────────────────────

export type WanInput = {
  image: string; // input image URL (the model spec calls it `image`)
  prompt: string;
  num_frames?: number; // default 81 (≈5 s @ 16 fps)
  frames_per_second?: number; // default 16
  resolution?: "480p" | "720p";
  go_fast?: boolean;
  interpolate_output?: boolean;
  sample_shift?: number;
  seed?: number;
  last_image?: string; // optional first-last-frame conditioning
};

/**
 * Wan 2.2 i2v fast — the workhorse for our animated explainers.
 * Costs ~$0.05 per clip at 480p/81 frames as of May 2026.
 * Returns the mp4 URL when the prediction succeeds.
 */
export async function runWan(input: WanInput, opts: { onTick?: (p: Prediction<string>) => void } = {}): Promise<string> {
  const started = await createPrediction<WanInput, string>({
    modelOwner: "wan-video",
    modelName: "wan-2.2-i2v-fast",
    input: {
      num_frames: 81,
      frames_per_second: 16,
      resolution: "480p",
      go_fast: true,
      interpolate_output: true,
      sample_shift: 12,
      ...input,
    },
  });
  const final = await pollPrediction(started, { onTick: opts.onTick });
  if (final.status !== "succeeded" || !final.output) {
    throw new Error(`Wan generation failed: ${final.error ?? final.status}`);
  }
  // Wan returns the mp4 URL as a plain string in `output`.
  return final.output as string;
}
