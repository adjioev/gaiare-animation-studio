#!/usr/bin/env node
// One-command release: bump the version across every manifest, commit, and
// tag. Pushing the tag is what triggers the GitHub Actions build
// (.github/workflows/release.yml) → draft Release with the dmg/msi.
//
// Usage:
//   pnpm release <X.Y.Z | major | minor | patch> [--push] [--dry-run]
//   pnpm release 0.2.0
//   pnpm release minor --push
//   pnpm release patch --dry-run   # preview only — no writes/commit/tag
//
// Without --push nothing leaves your machine: the bump + commit + tag are
// local, so you can inspect the diff before `git push origin main --follow-tags`.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUSH = process.argv.includes("--push");
const DRY = process.argv.includes("--dry-run");
const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));

function die(msg) {
  console.error(`[release] ${msg}`);
  process.exit(1);
}
function sh(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();
}

if (!arg) die("usage: pnpm release <X.Y.Z | major | minor | patch> [--push] [--dry-run]");

const pkgPath = join(ROOT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const cur = pkg.version;
const m = cur.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!m) die(`current version "${cur}" is not semver`);
const [maj, min, pat] = m.slice(1).map(Number);

let next;
if (arg === "major") next = `${maj + 1}.0.0`;
else if (arg === "minor") next = `${maj}.${min + 1}.0`;
else if (arg === "patch") next = `${maj}.${min}.${pat + 1}`;
else if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg;
else die(`invalid version "${arg}" — use major | minor | patch or X.Y.Z`);

const tag = `v${next}`;
const branch = sh("git rev-parse --abbrev-ref HEAD");

console.log(`[release] ${cur} → ${next}  (tag ${tag}, branch ${branch})`);

if (DRY) {
  console.log("[release] --dry-run: would bump package.json, src-tauri/tauri.conf.json,");
  console.log("           src-tauri/Cargo.toml, src-tauri/Cargo.lock; commit + tag; no push.");
  process.exit(0);
}

// Preconditions (real run only)
if (sh("git status --porcelain")) die("working tree not clean — commit or stash first");
if (branch !== "main") die(`on branch "${branch}" — cut releases from main`);
if (sh("git tag --list").split("\n").includes(tag)) die(`tag ${tag} already exists`);

// 1. package.json
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// 2. src-tauri/tauri.conf.json
const confPath = join(ROOT, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = next;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

// 3. src-tauri/Cargo.toml — the [package] version is the first `version = "…"`
const cargoPath = join(ROOT, "src-tauri", "Cargo.toml");
writeFileSync(
  cargoPath,
  readFileSync(cargoPath, "utf8").replace(/^version = "[^"]+"/m, `version = "${next}"`),
);

// 4. src-tauri/Cargo.lock — our own package's [[package]] entry
const lockPath = join(ROOT, "src-tauri", "Cargo.lock");
writeFileSync(
  lockPath,
  readFileSync(lockPath, "utf8").replace(
    /(name = "gaiare-animation-studio"\nversion = ")[^"]+(")/,
    `$1${next}$2`,
  ),
);

// Commit + annotated tag
sh("git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock");
sh(`git commit -m "chore: release ${tag}"`);
sh(`git tag -a ${tag} -m "Release ${tag}"`);
console.log(`[release] committed + tagged ${tag}`);

if (PUSH) {
  sh(`git push origin ${branch}`);
  sh(`git push origin ${tag}`);
  console.log(`[release] pushed ${branch} + ${tag} — GitHub Actions is building the release.`);
} else {
  console.log("[release] not pushed. To trigger the release build, run:");
  console.log(`           git push origin ${branch} && git push origin ${tag}`);
}
