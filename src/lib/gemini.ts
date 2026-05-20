// Gemini image-edit wrapper. Talks to the Rust `gemini_generate_image`
// proxy (which holds the API key). Used by the sign-fix flow: the source
// photo + the correct sign reference(s) go in, a corrected photo comes
// out.
//
// Approach (per user: "one call, image + several references — let the AI
// place them"): the whole source image is sent as the first conditioning
// image, the correct signs follow as references, and Gemini repaints the
// signs in place. No cropping / compositing — if placement turns out
// unreliable we fall back to per-sign crop-edit-composite (the GS-12
// ticket design).

import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/** Base64 image bytes (no `data:` prefix) + mime. Matches the Rust
 *  `InlineImage` / `GeneratedImage` serde shape (snake_case fields). */
export type InlineImage = { mime_type: string; data: string };

const SIGN_FIX_INSTRUCTION = `You are correcting a driving-theory exam photograph.

The FIRST image is the photo. An upscaling step degraded the road signs in it, so their symbols are now wrong. The remaining image(s) are the CORRECT reference versions of the road signs that appear in the photo.

Repaint each road sign in the photo so its face matches the correct reference sign — match each sign to its reference by shape and type. Keep every sign in its exact original position, size, angle and perspective. Do NOT move, add, or remove signs, and leave everything else (background, road, poles, lighting) unchanged. Output the full corrected photo.`;

/** Run the whole-image sign fix (no region targeting). Kept as a
 *  fallback — in practice Gemini misplaces the reference when several
 *  signs share the frame, which is why the primary path is the
 *  region-scoped `runGeminiCropEdit` below. */
export async function runGeminiSignFix(args: {
  sourceImage: InlineImage;
  references: InlineImage[];
  prompt: string;
  aspectRatio: string;
}): Promise<{ mimeType: string; dataB64: string }> {
  const res = await invoke<{ mime_type: string; data: string }>(
    "gemini_generate_image",
    {
      instruction: SIGN_FIX_INSTRUCTION,
      images: [args.sourceImage, ...args.references],
      prompt: args.prompt,
      aspectRatio: args.aspectRatio,
    },
  );
  return { mimeType: res.mime_type, dataB64: res.data };
}

const CROP_FIX_INSTRUCTION = `Two images are provided.
- Image 1: a photo crop that contains one road sign.
- Image 2: the correct version of that sign.

Your only task: paint the sign from image 2 onto the sign face in image 1. Reproduce image 2's exact symbol, shape and colours, fitted to the existing sign's position, size, angle, perspective and lighting in image 1.

Output image 1 with that single change applied. Every other pixel — background, road, rocks, sky, posts, other signs, framing — stays exactly as it is in image 1.`;

/** Region-scoped sign fix: a single sign's crop + its correct reference.
 *  The caller crops the region from the source and composites the result
 *  back, so the model only ever sees (and can only ever touch) ONE sign —
 *  it cannot place the reference on the wrong sign. */
export async function runGeminiCropEdit(args: {
  crop: InlineImage;
  reference: InlineImage;
  prompt: string;
  aspectRatio: string;
}): Promise<{ mimeType: string; dataB64: string }> {
  const res = await invoke<{ mime_type: string; data: string }>(
    "gemini_generate_image",
    {
      instruction: CROP_FIX_INSTRUCTION,
      images: [args.crop, args.reference],
      prompt: args.prompt,
      aspectRatio: args.aspectRatio,
    },
  );
  return { mimeType: res.mime_type, dataB64: res.data };
}

/** Decode base64 image bytes into an `HTMLImageElement` (for canvas
 *  compositing). */
export function loadImageFromBase64(
  b64: string,
  mime = "image/png",
): Promise<HTMLImageElement> {
  return loadImage(`data:${mime};base64,${b64}`);
}

// ─── Reference fetching ────────────────────────────────────────────────

/** Fetch a reference image URL and return inline base64. SVGs are
 *  rasterised to PNG in a canvas (Gemini wants raster bytes, not vector
 *  markup). */
export async function fetchReferenceInline(
  url: string,
  signal?: AbortSignal,
): Promise<InlineImage> {
  const res = await tauriFetch(url, { signal });
  if (!res.ok) {
    throw new Error(`reference fetch failed: ${res.status} ${url}`);
  }
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  const bytes = new Uint8Array(await res.arrayBuffer());

  const isSvg =
    contentType === "image/svg+xml" || url.toLowerCase().endsWith(".svg");
  if (isSvg) {
    // Render the vector to a crisp PNG in Rust (resvg) — far sharper than
    // the browser-canvas path, which decodes the SVG at its small intrinsic
    // size and then upscales the bitmap (blurry).
    const svgText = new TextDecoder().decode(bytes);
    const out = await invoke<{ mime_type: string; data: string }>(
      "rasterize_svg",
      { svg: svgText },
    );
    return { mime_type: out.mime_type, data: out.data };
  }
  return {
    mime_type: contentType || guessImageMime(url),
    data: bytesToBase64(bytes),
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to decode reference image"));
    img.src = src;
  });
}

// ─── byte / mime helpers ───────────────────────────────────────────────

/** Chunked to avoid blowing the call-stack on `String.fromCharCode(...)`
 *  for large images. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function guessImageMime(nameOrUrl: string): string {
  const lower = nameOrUrl.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}
