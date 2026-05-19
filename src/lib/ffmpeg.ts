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
  const out = await Command.sidecar("binaries/ffmpeg", [
    "-y",
    "-i",
    args.videoAbsPath,
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
    args.outputAbsPath,
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
  const out = await Command.sidecar("binaries/ffmpeg", [
    "-y",
    "-ss",
    String(args.timestampSeconds),
    "-i",
    args.videoAbsPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    args.outputAbsPath,
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
