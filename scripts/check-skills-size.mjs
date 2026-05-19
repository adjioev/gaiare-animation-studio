#!/usr/bin/env node
// Skills-doc size guard. The contents of `src/skills/*.md` get baked
// into the system prompt that the chat assistant ships on every turn,
// so unbounded growth means a linear increase in per-turn token cost.
// At Kimi K2.6 pricing (~$0.60/M input) a single skills file at 15 KB
// is still pennies per session, but the warning is cheap and a 50 KB+
// file is a smell — the doc should be pruned or split before then.
//
// Soft 5 KB → just a warning. Hard 15 KB → exit 1 so `predev`/
// `prebuild` aborts and a contributor has to acknowledge.

import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, "..", "src", "skills");

const WARN_BYTES = 5 * 1024;
const FAIL_BYTES = 15 * 1024;

let entries;
try {
  entries = readdirSync(SKILLS_DIR);
} catch {
  // No skills dir yet — nothing to check. Don't fail the build.
  process.exit(0);
}

let exitCode = 0;
for (const name of entries) {
  if (!name.endsWith(".md")) continue;
  const full = join(SKILLS_DIR, name);
  const bytes = statSync(full).size;
  if (bytes >= FAIL_BYTES) {
    console.error(
      `[skills] ✗ ${name} is ${bytes} bytes (hard cap ${FAIL_BYTES}). ` +
        `Trim or split before continuing.`,
    );
    exitCode = 1;
  } else if (bytes >= WARN_BYTES) {
    console.warn(
      `[skills] ⚠ ${name} is ${bytes} bytes (soft warn at ${WARN_BYTES}). ` +
        `Consider pruning or splitting into per-domain files.`,
    );
  }
}

process.exit(exitCode);
