# GS-9: Studio — workspace dir migration v2 → v3 + country selector

**Phase:** 3
**Effort:** 0.5 day
**Depends on:** none (independent of Phase 1/2, but lands cleanest after Phase 1)
**Repo:** `gaiare-project/gaiare-animation-studio` (Tauri/React)

## Summary

Migrate Studio's per-workspace storage from `qNN/` to
`<country>/qNN/` to support multi-country expansion (Georgia → Armenia
→ Italy / Azerbaijan / Kazakhstan). Bump `workspace.json` schema v2 →
v3 with a `country: "GE" | "AM" | ...` field. Add a country selector to
Settings + the New / Open modals.

## Why now (or now-ish)

Currently all workspaces are implicitly Georgia. Soon: Armenia (per
project memory). After that, naming collisions become real (Georgia Q14
vs Armenia Q14 share the workspace dir). Composite key fixes this
permanently. Cheaper to migrate while only Georgia data exists.

## Acceptance criteria

- [ ] `workspace.json` schema v3:
  - `version: 3` (was 2)
  - `country: string` (ISO country code: `"GE"`, `"AM"`, `"AZ"`, etc.)
  - All existing fields preserved
- [ ] On Studio app launch, a Rust command `migrate_workspace_dirs`
      runs once:
  - Scan `<Documents>/gaiare-animation-studio/` for top-level dirs
    matching `/^q\d+$/`
  - For each: move to `georgia/q<NN>` (architect: existing user data is
    all Georgia)
  - Inside each migrated workspace.json, set `country: "GE"` and bump
    `version: 3`
  - Write a sentinel file `gaiare-animation-studio/.migration_v3.lock`
    so the migration runs at most once
- [ ] If sentinel exists, skip — migration is idempotent
- [ ] If a `qNN/` dir exists at root after migration sentinel exists
      (rare — manual restore?), warn in console + don't auto-migrate
      (user should resolve)
- [ ] `Settings` gains `defaultCountry?: string` field, used by:
  - New / Open modal initial country filter
  - Falls back to `"GE"` (Georgia) if unset
- [ ] `SettingsModal` adds a "Default country" dropdown — populated from
      Rails `listCountries()` if connected, otherwise hardcoded fallback
      list (`GE / AM / AZ / IT / KZ`)
- [ ] Workspace lock files (`workspace.lock.<contractorId>`) stay
      filename-only inside the country-namespaced dir. No change to lock
      semantics — only the parent path changes.
- [ ] All workspace-resolving paths use the new layout:
  - `relPathForAsset` already takes folderName + externalRef + asset —
    extends to country implicitly via the workspace's own state
  - `qdir(folderName, externalRef)` → `qdir(folderName, country, externalRef)`
  - All call sites updated (search for `qdir(`)
- [ ] `loadWorkspace` reads `version`:
  - `version === 2` → migrate in-memory (set `country: "GE"`, bump to 3)
    then save before continuing — defensive in case the file-system
    migration missed an edge case
  - `version === 3` → load directly
  - Other versions → error + show in UI
- [ ] Tests / manual: migration is deterministic and safe to re-run

## Implementation notes

- Migration in Rust (not JS): `std::fs::rename` is atomic, faster, and
  avoids racing with Tauri's filesystem permission scope. Command name:
  `migrate_workspace_dirs(folder_name: String) -> MigrationReport`
- `MigrationReport` returns `{ moved: Vec<String>, errors: Vec<String> }`
  so the UI can show a one-time confirmation banner: "Migrated N
  workspaces to georgia/ namespace"
- Don't auto-migrate workspaces from someone else's machine that synced
  via iCloud / Dropbox — the sentinel file syncs too, so they'll see
  "already migrated" on first launch if the dir layout matches v3
  expectation. Cross-machine workspaces use per-contractor locks already.
- Country codes: ISO 3166-1 alpha-2 (`GE`, `AM`, `AZ`, `IT`, `KZ`).
  Lower-case in path (`georgia/`) — full lower-case English name for
  human-readable directory names. Mapping table in TS:
  ```ts
  const COUNTRY_DIR: Record<string, string> = {
    GE: "georgia", AM: "armenia", AZ: "azerbaijan",
    IT: "italy", KZ: "kazakhstan",
  };
  ```
- New workspaces created via GS-5 use `country_code` from the Rails
  question. Manual workspaces (fallback) use Settings.defaultCountry.

## Files touched

**New:**
- `src-tauri/src/workspace_migrate.rs` — `migrate_workspace_dirs`
  command + sentinel logic

**Modified:**
- `src-tauri/src/lib.rs` — register command, invoke on startup before
  any workspace operation
- `src/lib/workspace.ts`:
  - bump `WORKSPACE_VERSION` to 3
  - add `country` to `Workspace`
  - update `qdir`, `relPathForAsset`, `loadWorkspace`, `saveWorkspace`,
    `listWorkspaces` to thread `country` through
  - `migrateWorkspaceV2toV3(ws): Workspace` helper for defensive in-memory
    migration
- `src/lib/settings.ts` — `defaultCountry?`
- `src/App.tsx` — invoke `migrate_workspace_dirs` on bootstrap, surface
  one-time banner if migration moved workspaces
- `src/components/SettingsModal.tsx` — country dropdown
- `src/components/OpenQuestionModal.tsx` (from GS-5) — country filter
  uses Settings.defaultCountry as default

## Test plan

- [ ] On a machine with existing `q14/`, `q15/` workspaces (or simulate
      by creating these), launch new build
- [ ] Verify dirs moved to `georgia/q14/` and `georgia/q15/`
- [ ] Verify `.migration_v3.lock` exists at folder root
- [ ] Re-launch → no further migration runs
- [ ] Open Q14 → loads from `georgia/q14/workspace.json` with
      `version: 3`, `country: "GE"`
- [ ] All assets resolve correctly (frames, clips, stitched outputs)
- [ ] Chat history preserved
- [ ] Settings → Default country: change to "AM" → next "+ New" defaults
      to Armenia filter in the Rails browse modal
- [ ] Create a new workspace from a Rails question in Armenia → lands
      in `armenia/q<NN>/`
- [ ] Manually create a workspace via fallback flow with country = AZ
      → `azerbaijan/q<NN>/`

## Out of scope

- Cross-country asset sharing (each country's workspaces are isolated)
- Country-specific skills doc (skills.md is universal for now; multi-
  country prompt tuning is a future ticket)
- UI for browsing across countries simultaneously
