// Thin wrappers around ffmpeg / ffprobe subprocess calls via
// tauri-plugin-shell.
//
// Binaries are bundled as Tauri sidecars — `scripts/download-ffmpeg.mjs`
// fetches a static build for the host platform on `pnpm install`,
// places it in `src-tauri/binaries/` with the rustc target-triple
// suffix Tauri expects, and `tauri.conf.json`'s `externalBin` picks
// up the right one at build time. No `brew install ffmpeg` step
// required from contractors.

import { Command } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";

/**
 * Reject absolute paths that don't live under the user's Documents
 * folder, and canonicalise them so ffmpeg never sees `..` segments.
 * Delegates to a Rust command that uses `std::fs::canonicalize` — the
 * earlier TS-only `startsWith` check was bypassable two ways: `..` in
 * the relative path produced a string that lexically started with the
 * Documents root but resolved outside, and a sibling directory named
 * e.g. `DocumentsEvil` matched as a string prefix. Both are
 * theoretical-only with a trusted renderer, but the explicit goal of
 * the guard was defence against a future bug — so it should actually
 * hold.
 *
 * Returns the canonicalised path. Callers should use the return value
 * for the subsequent `Command::sidecar` invocation, not the original
 * input.
 */
export async function assertSafeDocumentPath(absPath: string): Promise<string> {
  return invoke<string>("assert_safe_document_path_cmd", { absPath });
}

/**
 * Duration of a video file in seconds, via ffprobe. Used to clamp the
 * mid-frame timestamp to a valid range so contractors can't ask ffmpeg
 * to seek past the end of the clip.
 */
export async function probeDurationSeconds(videoAbsPath: string): Promise<number> {
  const out = await Command.sidecar("binaries/ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    videoAbsPath,
  ]).execute();

  if (out.code !== 0) {
    throw new Error(`ffprobe failed: ${out.stderr.split("\n")[0] ?? "<no stderr>"}`);
  }
  const d = Number.parseFloat(out.stdout.trim());
  if (!Number.isFinite(d) || d <= 0) {
    throw new Error(`ffprobe returned invalid duration: "${out.stdout.trim()}"`);
  }
  return d;
}

/**
 * Concatenate a list of clips into a single video, in order. Re-encodes
 * with libx264 so the result is bulletproof against minor differences
 * between inputs (varying GOP structure, slight pix_fmt drift, etc.).
 * `-r 16` forces constant 16 fps output — without it, concat'd clips
 * with slightly mismatched timestamps would produce a variable-fps
 * file that browsers play back at the wrong speed.
 *
 * Each input path is run through `assertSafeDocumentPath` to keep ffmpeg
 * from touching anything outside the Documents tree.
 */
export async function stitchClips(args: {
  inputAbsPaths: string[];
  outputAbsPath: string;
}): Promise<void> {
  if (args.inputAbsPaths.length < 2) {
    throw new Error("stitchClips needs at least 2 inputs");
  }
  // Canonicalise every path — use the returned form for the ffmpeg
  // call so the subprocess sees no `..` segments. Otherwise a value
  // could pass the prefix check as a string but resolve outside
  // Documents at the OS level.
  const safeInputs: string[] = [];
  for (const p of args.inputAbsPaths) {
    safeInputs.push(await assertSafeDocumentPath(p));
  }
  const safeOutput = await assertSafeDocumentPath(args.outputAbsPath);

  // Build `-i clip1 -i clip2 ...` plus the matching filter graph.
  // Each input is scaled+padded to a canonical 854×480 before concat:
  // `concat` filter requires identical dimensions across all streams,
  // and Wan output / trim re-encode resolutions can drift by a few
  // pixels between runs (or differ entirely for future user-supplied
  // clips). `force_original_aspect_ratio=decrease` preserves the
  // input's aspect ratio; the `pad` fills the rest with black bars.
  // `setsar=1` normalises sample-aspect to avoid stretched output.
  const TARGET_W = 854;
  const TARGET_H = 480;
  const inputArgs: string[] = [];
  const filterParts: string[] = [];
  const concatStreams: string[] = [];
  for (let i = 0; i < safeInputs.length; i++) {
    inputArgs.push("-i", safeInputs[i]!);
    filterParts.push(
      `[${i}:v]scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,` +
        `pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`,
    );
    concatStreams.push(`[v${i}]`);
  }
  filterParts.push(
    `${concatStreams.join("")}concat=n=${safeInputs.length}:v=1:a=0[v]`,
  );
  const filter = filterParts.join(";");

  const out = await Command.sidecar("binaries/ffmpeg", [
    "-y",
    ...inputArgs,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-r",
    "16",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
    safeOutput,
  ]).execute();

  if (out.code !== 0) {
    throw new Error(`ffmpeg stitchClips failed: ${ffmpegErrorSummary(out.stderr)}`);
  }
}

export async function trimClip(args: {
  videoAbsPath: string;
  startSeconds: number;
  endSeconds: number;
  outputAbsPath: string;
}): Promise<void> {
  // Re-encode for frame-accurate cuts. `-c copy` would be ~10× faster
  // but only cuts on keyframes — Wan i2v output keyframes ~0.5 s apart,
  // and at 5 s total clip length a half-second drift is 10 % of the
  // duration. Re-encoding with libx264 -preset veryfast adds ~1-2 s
  // wall time, which is invisible next to the 30-60 s Wan generation
  // it follows.
  //
  // Output seek (`-ss` AFTER `-i`) seeks the decoded stream rather
  // than the container, so we land exactly on the asked-for frame.
  const duration = Math.max(0.05, args.endSeconds - args.startSeconds);
  const safeInput = await assertSafeDocumentPath(args.videoAbsPath);
  const safeOutput = await assertSafeDocumentPath(args.outputAbsPath);
  const out = await Command.sidecar("binaries/ffmpeg", [
    "-y",
    "-i",
    safeInput,
    "-ss",
    String(args.startSeconds),
    "-t",
    String(duration),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an", // Wan clips have no audio; -an drops any stray empty track
    safeOutput,
  ]).execute();

  if (out.code !== 0) {
    throw new Error(`ffmpeg trimClip failed: ${ffmpegErrorSummary(out.stderr)}`);
  }
}

export async function extractFrame(args: {
  videoAbsPath: string;
  timestampSeconds: number;
  outputAbsPath: string;
}): Promise<void> {
  // Input seek (`-ss` before `-i`) is fast but only frame-precise to
  // the nearest keyframe (~0.5 s). For mid-frame picking this is fine
  // — contractors choose the timestamp by eye, not to a single frame.
  const safeInput = await assertSafeDocumentPath(args.videoAbsPath);
  const safeOutput = await assertSafeDocumentPath(args.outputAbsPath);
  const out = await Command.sidecar("binaries/ffmpeg", [
    "-y",
    "-ss",
    String(args.timestampSeconds),
    "-i",
    safeInput,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    safeOutput,
  ]).execute();

  if (out.code !== 0) {
    throw new Error(`ffmpeg extractFrame failed: ${ffmpegErrorSummary(out.stderr)}`);
  }
}

/**
 * ffmpeg dumps its full build configuration on every error. The useful
 * signal usually sits in the last few lines or in a line containing
 * "Error". Pick the most informative chunk so the UI status pill stays
 * scannable.
 */
function ffmpegErrorSummary(stderr: string): string {
  if (!stderr) return "(no stderr)";
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const errLine = lines.find((l) => /error|invalid|failed|no such/i.test(l));
  if (errLine) return errLine.slice(0, 240);
  return (lines[lines.length - 1] ?? stderr).slice(0, 240);
}
