#!/usr/bin/env node
// Downloads ffmpeg + ffprobe for the HOST platform and places them in
// `src-tauri/binaries/` with Tauri's sidecar naming convention
// (`<bin>-<rustc-target-triple>[.exe]`).
//
// Run automatically via `pnpm install` (postinstall, **non-fatal** so a
// network blip doesn't break the whole install) and before every
// `pnpm tauri dev` / `pnpm tauri build` via the strict variants below.
//
// SHA-256 pinning: each platform records the expected hash of the
// installed binary. A mismatch on a subsequent run aborts loudly
// instead of silently shipping a different upstream build into the
// `.app` — that closes the "what if evermeet.cx or gyan.dev gets
// taken over" hole. Platforms without an `expected` hash logged are
// in bootstrap mode: the script captures the hash on first run and
// asks the operator to commit it.
//
// `--strict` flag forces a hard exit on any failure (network error,
// SHA mismatch, missing platform). Used by `pretauri:dev` and
// `pretauri:build`. Without `--strict` the script logs and exits 0
// so `pnpm install` succeeds even offline.

import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const BIN_DIR = join(PROJECT_ROOT, "src-tauri", "binaries");

const STRICT = process.argv.includes("--strict");

const TARGETS = {
  // macOS — evermeet.cx publishes a fresh static build per ffmpeg
  // release. URLs are "latest" because they don't expose versioned
  // ones for older builds; the SHA pin is what locks us to a known-
  // good version. Update the SHAs whenever you intentionally adopt a
  // new ffmpeg release.
  "darwin-arm64": {
    triple: "aarch64-apple-darwin",
    ffmpeg: "https://evermeet.cx/ffmpeg/getrelease/zip",
    ffprobe: "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip",
    archive: "zip",
    expected: {
      ffmpeg:
        "3a0ea97adddecfbf87b865da3bcbb321edfce4bab18a98ae1ba4ba9f0bd1f93a",
      ffprobe:
        "a976306bcb8c9c50b2ac4e91f5aac4e45395e1f9063c46aecf1e1213e41c631b",
    },
  },
  "darwin-x64": {
    triple: "x86_64-apple-darwin",
    ffmpeg: "https://evermeet.cx/ffmpeg/getrelease/zip",
    ffprobe: "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip",
    archive: "zip",
    // Bootstrap mode — capture SHAs from the first run and paste here.
    expected: { ffmpeg: null, ffprobe: null },
  },
  // Windows — gyan.dev ships a single zip with both binaries under
  // bin/. Use a short extract path to dodge MAX_PATH=260 issues on
  // older Windows / deep $env:TEMP.
  "win32-x64": {
    triple: "x86_64-pc-windows-msvc",
    bundle: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    archive: "zip",
    inside: "bin/",
    expected: { ffmpeg: null, ffprobe: null },
  },
  "linux-x64": {
    triple: "x86_64-unknown-linux-gnu",
    bundle:
      "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
    archive: "tar.xz",
    inside: "",
    expected: { ffmpeg: null, ffprobe: null },
  },
};

const key = `${platform()}-${arch()}`;
const target = TARGETS[key];

function fail(message) {
  if (STRICT) {
    console.error(`[ffmpeg-sidecar] ${message}`);
    process.exit(1);
  } else {
    console.error(`[ffmpeg-sidecar] (non-fatal) ${message}`);
    console.error(
      `[ffmpeg-sidecar] Run \`node scripts/download-ffmpeg.mjs --strict\` manually after fixing.`,
    );
    process.exit(0);
  }
}

if (!target) {
  fail(
    `Unsupported host platform: ${key}. Supported: darwin-arm64, darwin-x64, win32-x64, linux-x64`,
  );
}

const exe = platform() === "win32" ? ".exe" : "";
const ffmpegOut = join(BIN_DIR, `ffmpeg-${target.triple}${exe}`);
const ffprobeOut = join(BIN_DIR, `ffprobe-${target.triple}${exe}`);

if (existsSync(ffmpegOut) && existsSync(ffprobeOut)) {
  console.log(`[ffmpeg-sidecar] Already present in ${BIN_DIR}`);
  process.exit(0);
}

mkdirSync(BIN_DIR, { recursive: true });
// Short path on Windows — `Expand-Archive` chokes silently when the
// extracted path exceeds MAX_PATH=260 (gyan.dev's nested versioned
// dir + a deep $env:TEMP can blow past it).
const workDir =
  platform() === "win32"
    ? `C:\\Temp\\ffmpeg-dl-${Date.now()}`
    : join(tmpdir(), `ffmpeg-dl-${Date.now()}`);
mkdirSync(workDir, { recursive: true });

async function downloadTo(url, dest) {
  console.log(`[ffmpeg-sidecar] GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
}

function extractZip(archivePath, extractDir) {
  if (platform() === "win32") {
    // `-ErrorAction Stop` propagates non-zero exit; without it
    // Expand-Archive swallows failures and we'd extract nothing
    // silently. `tar -xf` is also available on Windows 10+ (since
    // 1803) and arguably more reliable, but Expand-Archive avoids the
    // bsdtar dependency on older builds.
    execSync(
      `powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force"`,
      { stdio: "inherit" },
    );
  } else {
    execSync(`unzip -q -o "${archivePath}" -d "${extractDir}"`, {
      stdio: "inherit",
    });
  }
}

function extractTar(archivePath, extractDir) {
  execSync(`tar -xf "${archivePath}" -C "${extractDir}"`, { stdio: "inherit" });
}

function findRecursive(rootDir, basename) {
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const found = findRecursive(full, basename);
      if (found) return found;
    } else if (entry.name === basename) {
      return full;
    }
  }
  return null;
}

function sha256OfFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function verifyOrThrow(binPath, expected, name) {
  const actual = await sha256OfFile(binPath);
  if (!expected) {
    console.warn(
      `[ffmpeg-sidecar] ⚠ No expected SHA for ${name} on ${key} — bootstrap mode.`,
    );
    console.warn(`[ffmpeg-sidecar]   Captured SHA: ${actual}`);
    console.warn(
      `[ffmpeg-sidecar]   Paste into TARGETS["${key}"].expected.${name} after verifying.`,
    );
    return;
  }
  if (actual !== expected) {
    throw new Error(
      `SHA-256 mismatch for ${name} (${key}):\n` +
        `  expected: ${expected}\n` +
        `  actual:   ${actual}\n` +
        `Upstream changed. Verify the new binary is legitimate (download manually, ` +
        `inspect, test) before updating TARGETS.${key}.expected.${name}.`,
    );
  }
}

async function placeBinary(url, archiveType, binaryName, outPath, expected) {
  const archivePath = join(workDir, `${binaryName}.${archiveType}`);
  await downloadTo(url, archivePath);
  const extractDir = join(workDir, `${binaryName}-extracted`);
  mkdirSync(extractDir, { recursive: true });
  if (archiveType === "zip") extractZip(archivePath, extractDir);
  else if (archiveType.startsWith("tar")) extractTar(archivePath, extractDir);
  else throw new Error(`Unknown archive type ${archiveType}`);

  const candidate = findRecursive(
    extractDir,
    platform() === "win32" ? `${binaryName}.exe` : binaryName,
  );
  if (!candidate) {
    throw new Error(`Couldn't locate ${binaryName} inside ${archivePath}`);
  }
  await verifyOrThrow(candidate, expected, binaryName);
  renameSync(candidate, outPath);
  if (platform() !== "win32") chmodSync(outPath, 0o755);
}

try {
  if (target.bundle) {
    const archivePath = join(workDir, `bundle.${target.archive}`);
    await downloadTo(target.bundle, archivePath);
    const extractDir = join(workDir, "bundle-extracted");
    mkdirSync(extractDir, { recursive: true });
    if (target.archive === "zip") extractZip(archivePath, extractDir);
    else extractTar(archivePath, extractDir);

    const ffmpegSrc = findRecursive(
      extractDir,
      platform() === "win32" ? "ffmpeg.exe" : "ffmpeg",
    );
    const ffprobeSrc = findRecursive(
      extractDir,
      platform() === "win32" ? "ffprobe.exe" : "ffprobe",
    );
    if (!ffmpegSrc || !ffprobeSrc) {
      throw new Error("ffmpeg or ffprobe missing inside the bundle archive");
    }
    await verifyOrThrow(ffmpegSrc, target.expected.ffmpeg, "ffmpeg");
    await verifyOrThrow(ffprobeSrc, target.expected.ffprobe, "ffprobe");
    renameSync(ffmpegSrc, ffmpegOut);
    renameSync(ffprobeSrc, ffprobeOut);
    if (platform() !== "win32") {
      chmodSync(ffmpegOut, 0o755);
      chmodSync(ffprobeOut, 0o755);
    }
  } else {
    await placeBinary(
      target.ffmpeg,
      target.archive,
      "ffmpeg",
      ffmpegOut,
      target.expected.ffmpeg,
    );
    await placeBinary(
      target.ffprobe,
      target.archive,
      "ffprobe",
      ffprobeOut,
      target.expected.ffprobe,
    );
  }
  console.log(`[ffmpeg-sidecar] ✓ ${ffmpegOut}`);
  console.log(`[ffmpeg-sidecar] ✓ ${ffprobeOut}`);
} catch (err) {
  fail(err.message);
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}
