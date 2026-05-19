// Replicate client — thin wrapper over the Rust commands defined in
// `src-tauri/src/replicate.rs`. The API token lives in the Rust
// process (loaded from `.env` via dotenvy on app start) and never
// crosses into the renderer's JS bundle.
//
// The renderer still owns the poll loop, status callbacks, and
// AbortSignal — Rust just relays HTTPS calls.

import { invoke } from "@tauri-apps/api/core";

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

function isValidPrediction(value: unknown): value is Prediction<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.status === "string" &&
    ["starting", "processing", "succeeded", "failed", "canceled"].includes(
      v.status,
    ) &&
    typeof v.urls === "object" &&
    v.urls !== null
  );
}

/** Best-effort cancellation — swallow errors because callers are
 *  usually already abandoning the result. */
async function cancelPrediction(cancelUrl: string): Promise<void> {
  try {
    await invoke("replicate_cancel_prediction", { url: cancelUrl });
  } catch {
    // ignore
  }
}

async function pollPrediction<TOutput>(
  initial: Prediction<TOutput>,
  opts: {
    intervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    onTick?: (p: Prediction<TOutput>) => void;
  } = {},
): Promise<Prediction<TOutput>> {
  const interval = opts.intervalMs ?? 1500;
  const timeout = opts.timeoutMs ?? 180_000;
  const started = Date.now();
  let current = initial;

  while (
    current.status !== "succeeded" &&
    current.status !== "failed" &&
    current.status !== "canceled"
  ) {
    if (opts.signal?.aborted) {
      await cancelPrediction(current.urls.cancel);
      throw new DOMException("Generation aborted by caller", "AbortError");
    }
    if (Date.now() - started > timeout) {
      await cancelPrediction(current.urls.cancel);
      throw new Error(`Prediction ${current.id} timed out after ${timeout} ms`);
    }
    await new Promise((r) => setTimeout(r, interval));
    if (opts.signal?.aborted) {
      await cancelPrediction(current.urls.cancel);
      throw new DOMException("Generation aborted by caller", "AbortError");
    }
    const next = await invoke<unknown>("replicate_get_prediction", {
      url: current.urls.get,
    });
    if (!isValidPrediction(next)) {
      throw new Error("Replicate returned an unexpected response shape");
    }
    current = next as Prediction<TOutput>;
    opts.onTick?.(current);
  }
  return current;
}

/**
 * Wan 2.2 i2v fast — the workhorse for our animated explainers.
 * Costs ~$0.05 per clip at 480p / 81 frames as of May 2026.
 *
 * The model slug and default inference parameters are constants in TS
 * (not baked into Rust) so model upgrades are a TypeScript change,
 * not a Rust rebuild + redistribute. The Rust proxy still validates
 * the model is on its allowlist (`src-tauri/src/replicate.rs`).
 */
export const WAN_MODEL = "wan-video/wan-2.2-i2v-fast";

const WAN_DEFAULT_PARAMS = {
  num_frames: 81,
  frames_per_second: 16,
  resolution: "480p",
  go_fast: true,
  interpolate_output: true,
  sample_shift: 12,
} as const;

export async function runWan(
  input: { image: string; prompt: string },
  opts: { signal?: AbortSignal; onTick?: (p: Prediction<string>) => void } = {},
): Promise<string> {
  const started = await invoke<unknown>("replicate_create_prediction", {
    model: WAN_MODEL,
    input: { ...WAN_DEFAULT_PARAMS, ...input },
  });
  if (!isValidPrediction(started)) {
    throw new Error("Replicate returned an unexpected response shape");
  }
  const final = await pollPrediction(started as Prediction<string>, {
    signal: opts.signal,
    onTick: opts.onTick,
  });
  if (final.status !== "succeeded" || !final.output) {
    throw new Error(`Wan generation failed: ${final.error ?? final.status}`);
  }
  return final.output as string;
}
