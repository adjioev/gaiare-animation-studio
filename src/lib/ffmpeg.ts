// Thin wrappers around ffmpeg subprocess calls via tauri-plugin-shell.
// Assumes `ffmpeg` is on the user's PATH (Homebrew install on macOS,
// `apt install ffmpeg` on Linux, choco/winget on Windows). Future
// production builds should sidecar a bundled ffmpeg binary so we don't
// depend on the host install.

import { Command } from "@tauri-apps/plugin-shell";

/**
 * Return the duration of a video file in seconds, via ffprobe. Used to
 * clamp the mid-frame timestamp to a valid range so contractors can't
 * ask ffmpeg to seek past the end of the clip.
 */
export async function probeDurationSeconds(videoAbsPath: string): Promise<number> {
  const out = await Command.create("ffprobe", [
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

export async function extractFrame(args: {
  videoAbsPath: string;
  timestampSeconds: number;
  outputAbsPath: string;
}): Promise<void> {
  // Input seek (`-ss` before `-i`) is fast but only frame-precise to the
  // nearest keyframe (~0.5 s). For mid-frame picking this is fine —
  // contractors choose the timestamp by eye, not to a single frame.
  const out = await Command.create("ffmpeg", [
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

export async function trim(args: {
  videoAbsPath: string;
  durationSeconds: number;
  outputAbsPath: string;
}): Promise<void> {
  const out = await Command.create("ffmpeg", [
    "-y",
    "-i",
    args.videoAbsPath,
    "-t",
    String(args.durationSeconds),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    args.outputAbsPath,
  ]).execute();

  if (out.code !== 0) {
    throw new Error(`ffmpeg trim failed: ${ffmpegErrorSummary(out.stderr)}`);
  }
}

/**
 * Concat two clips with a hard cut. Assumes the last frame of clip 1
 * matches the first frame of clip 2 (which holds when clip 2 is
 * generated from clip 1's mid-frame). Re-encodes to make the cut
 * seamless — copy mode (`-c copy`) leaves a brief decoder glitch at
 * the boundary on some players.
 */
export async function concatHardCut(args: {
  parts: string[]; // absolute paths in order
  outputAbsPath: string;
}): Promise<void> {
  if (args.parts.length < 2) {
    throw new Error("concatHardCut needs at least 2 parts");
  }

  // ffmpeg concat filter: [0:v][1:v]concat=n=N:v=1:a=0
  const inputs = args.parts.flatMap((p) => ["-i", p]);
  const filter =
    args.parts.map((_, i) => `[${i}:v]`).join("") +
    `concat=n=${args.parts.length}:v=1:a=0[v]`;

  const out = await Command.create("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    args.outputAbsPath,
  ]).execute();

  if (out.code !== 0) {
    throw new Error(`ffmpeg concat failed: ${ffmpegErrorSummary(out.stderr)}`);
  }
}

/**
 * Stitch trimmed clip 1 (up to handoffSeconds) + full clip 2. This is
 * the q14 production recipe — clip 2 already starts from the same
 * frame we cut clip 1 at, so the boundary is invisible.
 */
export async function stitchAtHandoff(args: {
  clip1AbsPath: string;
  clip2AbsPath: string;
  handoffSeconds: number;
  outputAbsPath: string;
}): Promise<void> {
  const filter =
    `[0:v]trim=0:${args.handoffSeconds},setpts=PTS-STARTPTS[v1];` +
    `[1:v]setpts=PTS-STARTPTS[v2];` +
    `[v1][v2]concat=n=2:v=1:a=0[v]`;

  const out = await Command.create("ffmpeg", [
    "-y",
    "-i",
    args.clip1AbsPath,
    "-i",
    args.clip2AbsPath,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    args.outputAbsPath,
  ]).execute();

  if (out.code !== 0) {
    throw new Error(`ffmpeg stitchAtHandoff failed: ${ffmpegErrorSummary(out.stderr)}`);
  }
}

export async function muxAudio(args: {
  videoAbsPath: string;
  audioAbsPath: string;
  outputAbsPath: string;
}): Promise<void> {
  const out = await Command.create("ffmpeg", [
    "-y",
    "-i",
    args.videoAbsPath,
    "-i",
    args.audioAbsPath,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    args.outputAbsPath,
  ]).execute();

  if (out.code !== 0) {
    throw new Error(`ffmpeg muxAudio failed: ${ffmpegErrorSummary(out.stderr)}`);
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
  // Prefer the first line containing "Error" or "Invalid"
  const errLine = lines.find((l) => /error|invalid|failed|no such/i.test(l));
  if (errLine) return errLine.slice(0, 240);
  // Fallback: the last non-empty line is usually the conclusion.
  return (lines[lines.length - 1] ?? stderr).slice(0, 240);
}
