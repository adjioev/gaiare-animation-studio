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
 * Upload a local file to Replicate's Files API and get back the URL
 * predictions should use as their `input.image` (or similar).
 *
 * Workspaces start with a single CDN-hosted source image (the workspace
 * config has its URL), but every subsequent asset — extracted frames,
 * trimmed clips, stitched videos — lives only on the user's disk and
 * has no URL Wan can fetch from. This wrapper bridges that gap on
 * demand. The result expires after ~24 h on Replicate's side, so call
 * fresh per generation rather than caching long-term.
 */
export async function uploadFileToReplicate(absPath: string): Promise<string> {
  const res = await invoke<unknown>("replicate_upload_file", { absPath });
  if (typeof res !== "object" || res === null) {
    throw new Error("replicate_upload_file returned non-object");
  }
  const url = (res as { url?: unknown }).url;
  if (typeof url !== "string") {
    throw new Error("replicate_upload_file returned no url");
  }
  return url;
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

/** Black Forest Labs Flux Kontext Pro — image-to-image edits with
 *  natural-language instructions ("remove the yellow arrows", "change
 *  the red car to blue"). ~$0.04/edit as of May 2026. The Transform
 *  tab uses this to clean exam imagery before Wan animates it. */
export const FLUX_KONTEXT_MODEL = "black-forest-labs/flux-kontext-pro";

/** Rough per-call cost in USD for the cost-meter tooltip. Replicate's
 *  billing is the source of truth; this is a UI hint. Update if pricing
 *  shifts. */
export const FLUX_KONTEXT_COST_USD = 0.04;

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

/**
 * Flux Kontext Pro — single-shot image edit. Input: an image URL and a
 * natural-language instruction. Output: a single image URL hosted on
 * Replicate's CDN. We pull it locally via `downloadInto` in the
 * Transform tab and save as a new image asset.
 *
 * `output_format: "png"` — the model only accepts `jpg | png` (webp is
 * rejected with a 422). PNG is lossless, which avoids JPEG compression
 * artifacts in the region the edit fills in (e.g. the asphalt patched
 * over removed arrows).
 */
const FLUX_KONTEXT_DEFAULT_PARAMS = {
  output_format: "png",
  // Match input aspect by default so the cleaned image lines up
  // pixel-for-pixel with the original when used as a Wan start frame.
  aspect_ratio: "match_input_image",
} as const;

export async function runFluxKontext(
  input: { input_image: string; prompt: string },
  opts: { signal?: AbortSignal; onTick?: (p: Prediction<string>) => void } = {},
): Promise<string> {
  const started = await invoke<unknown>("replicate_create_prediction", {
    model: FLUX_KONTEXT_MODEL,
    input: { ...FLUX_KONTEXT_DEFAULT_PARAMS, ...input },
  });
  if (!isValidPrediction(started)) {
    throw new Error("Replicate returned an unexpected response shape");
  }
  const final = await pollPrediction(started as Prediction<string>, {
    signal: opts.signal,
    onTick: opts.onTick,
  });
  if (final.status !== "succeeded" || !final.output) {
    throw new Error(`Flux Kontext edit failed: ${final.error ?? final.status}`);
  }
  return final.output as string;
}

// ─── Image enhance (SeedVR2 upscale + Clarity polish) ──────────────────
//
// Pinned model versions mirror the Rails mastra pipeline
// (apps/mastra-agents/src/lib/replicate.ts MODEL_VERSIONS) so the studio
// produces output identical to the server enhance. Pinned here in TS —
// bumping a version is a one-line change; the Rust proxy only validates
// the hash shape (64 hex chars), not the specific value.

export const SEEDVR2_VERSION =
  "ca98249be9cb623f02a80a7851a2b1a33d5104c251a8f5a1588f251f79bf7c78";
export const CLARITY_VERSION =
  "dfad41707589d68ecdccd1dfa600d55a208f9310748e44bfe35b4a6291453d5e";

/** Replicate output is sometimes a bare URL, sometimes a one-element
 *  array — normalise to the first string URL. */
function firstOutputUrl(output: unknown): string {
  const url = Array.isArray(output) ? output[0] : output;
  if (typeof url !== "string" || !url) {
    throw new Error("Replicate returned no output URL");
  }
  return url;
}

/** SeedVR2 7b — content-preserving super-resolution upscale. `imageUrl`
 *  must be an HTTPS URL Replicate can fetch. Inputs match the mastra
 *  pipeline exactly. Returns the upscaled image URL. */
export async function runSeedVR2(
  imageUrl: string,
  opts: { signal?: AbortSignal; onTick?: (p: Prediction<string>) => void } = {},
): Promise<string> {
  const started = await invoke<unknown>(
    "replicate_create_prediction_by_version",
    {
      version: SEEDVR2_VERSION,
      input: {
        media: imageUrl,
        model_variant: "7b",
        cfg_scale: 1,
        sample_steps: 1,
        apply_color_fix: true,
        output_format: "png",
        output_quality: 100,
      },
    },
  );
  if (!isValidPrediction(started)) {
    throw new Error("Replicate returned an unexpected response shape");
  }
  const final = await pollPrediction(started as Prediction<string>, {
    signal: opts.signal,
    onTick: opts.onTick,
  });
  if (final.status !== "succeeded") {
    throw new Error(`SeedVR2 failed: ${final.error ?? final.status}`);
  }
  return firstOutputUrl(final.output);
}

/** Clarity Upscaler — fine-detail polish pass. Returns the polished URL. */
export async function runClarity(
  imageUrl: string,
  opts: { signal?: AbortSignal; onTick?: (p: Prediction<string>) => void } = {},
): Promise<string> {
  const started = await invoke<unknown>(
    "replicate_create_prediction_by_version",
    {
      version: CLARITY_VERSION,
      input: { image: imageUrl },
    },
  );
  if (!isValidPrediction(started)) {
    throw new Error("Replicate returned an unexpected response shape");
  }
  const final = await pollPrediction(started as Prediction<string>, {
    signal: opts.signal,
    onTick: opts.onTick,
  });
  if (final.status !== "succeeded") {
    throw new Error(`Clarity failed: ${final.error ?? final.status}`);
  }
  return firstOutputUrl(final.output);
}
