# Releasing the Animation Studio

How to cut an installable build (`.dmg` for macOS, `.msi`/`.exe` for Windows) for designers to download.

A release is **two commands**: bump+tag locally, then push the tag. Pushing the tag triggers the GitHub Actions build (`.github/workflows/release.yml`), which produces the installers and attaches them to a **draft GitHub Release** you review and publish.

## Prerequisites

- You're on `main` with a **clean working tree** (`git status` empty).
- You can push to the repo and the repo has GitHub Actions enabled.
- Designers don't need anything bundled — they enter their own API keys in the app (**Settings → API keys**); the build ships no secrets.
- **Updater signing secrets are configured** (one-time, see below) — without them the build still produces installers, but the in-app auto-updater won't work.

## Auto-update (in-app)

Installed apps update themselves: on launch (and via **Settings → About → Check for updates**) the app reads the latest **published** GitHub Release, and if it's newer, offers a **Download & Restart** that installs in place — no manual reinstall.

This requires a one-time minisign signing key. The **public** key is committed in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); the **private** key + its password must exist as repo **Actions secrets** so CI can sign the bundles and generate the `latest.json` feed:

- `TAURI_SIGNING_PRIVATE_KEY` — contents of the private key file (`gaiare-updater.key`).
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password chosen when the key was generated.

Add them under **repo → Settings → Secrets and variables → Actions → New repository secret**. To rotate the key, run `pnpm tauri signer generate -w gaiare-updater.key`, replace the `pubkey` in `tauri.conf.json`, and update both secrets. Keep the private key out of git (it's in `.gitignore`).

> **Note:** this minisign key is *separate* from OS code-signing (EPIC-12.3). It makes updates trustworthy/automatic but does **not** remove the first-install Gatekeeper/SmartScreen warning. Builds already installed *before* the updater shipped have no updater — those users must do **one** last manual install of an updater-enabled build; everything after that is automatic.

## Cut a release

```bash
# 1. Preview the version bump (no changes made)
pnpm release minor --dry-run        # e.g. 0.1.0 → 0.2.0

# 2. Bump + commit + tag (local only — nothing pushed yet)
pnpm release minor                  # or: patch | major | an exact 0.2.0

# 3. Inspect, then push (this is what triggers the build)
git show --stat                     # sanity-check the version bump commit
git push origin main && git push origin v0.2.0
```

`pnpm release` bumps the version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` (kept in sync), commits `chore: release vX.Y.Z`, and creates an annotated tag. It refuses to run on a dirty tree, off `main`, or if the tag already exists.

> Shortcut: `pnpm release minor --push` does the push for you. Prefer the manual push above when you want to eyeball the commit first.

## What GitHub Actions does

On the tag push, the `Release` workflow runs on a macOS (Apple Silicon) and a Windows runner in parallel:
1. Installs deps, fetches the ffmpeg/ffprobe sidecars for the target.
2. Builds the app (`tauri build`) and signs the updater artifacts with `TAURI_SIGNING_PRIVATE_KEY`.
3. Creates/updates a **draft Release** named `Studio vX.Y.Z` and uploads the `.dmg` (macOS) + `.msi`/`.exe` (Windows), plus the updater bundles and a `latest.json` feed (what installed apps poll).

Watch it under the repo's **Actions** tab (~10–20 min).

## Before publishing

1. Open the **draft Release** (repo → Releases).
2. Download the installer for your OS and do a quick smoke test: it installs, launches, and a workspace + an API-key-backed action (e.g. a Replicate edit) works after entering keys in Settings.
3. Edit the release notes if needed, then **Publish**. Designers download from the Releases page.

## Installing an unsigned build (for designers)

The builds aren't code-signed (see EPIC-12.3), so the OS shows a one-time scary
warning on first launch. It's harmless — paste these steps into the release notes
so designers can get past it. **You only do this once per install.**

### macOS (`.dmg`)

1. Open the `.dmg` and drag **Gaiare Animation Studio** into **Applications**.
2. Double-clicking it the first time fails with *"can't be opened because Apple
   cannot check it for malicious software"* — that's expected.
3. Open **System Settings → Privacy & Security**, scroll down to the message
   *"Gaiare Animation Studio was blocked…"*, and click **Open Anyway** →
   **Open**.
   - On older macOS you can instead **right-click the app → Open → Open**.
4. It launches normally from then on.

### Windows (`.msi` / `.exe`)

1. Run the installer. Windows SmartScreen shows *"Windows protected your PC"*.
2. Click **More info → Run anyway**, then continue the install.
3. The installed app launches normally afterwards.

> If first launch still misbehaves on macOS (repeated keychain prompts, lost API
> keys), that's the unsigned-build keychain quirk — the fix is to sign the macOS
> build (EPIC-12.3), not a per-user workaround.

## Build without releasing (testing)

Use the **workflow_dispatch** trigger: repo → Actions → *Release* → *Run workflow*. It builds the same installers and uploads them as **run artifacts** (no Release is created). Good for verifying a build off a non-tag commit.

## Versioning

Semantic versioning, tag form `vX.Y.Z`:
- **patch** — bug fixes only.
- **minor** — new features, backward-compatible.
- **major** — breaking changes.

The tag and the version in the manifests must match — `pnpm release` guarantees this.

## Rolling back a bad release

```bash
# Delete the remote tag + the (draft or published) Release
git push origin :v0.2.0            # remove the remote tag
# then delete the Release from the GitHub Releases UI
git tag -d v0.2.0                  # remove the local tag
```
Then fix forward and cut a new patch (`pnpm release patch`). Don't reuse a version number.

> **Updater note:** deleting a published Release repoints the `latest.json` feed to the previous version. The updater never *downgrades*, so apps already on the bad version won't roll back on their own — they sit tight until you publish a higher version. Prefer fixing forward with a new patch over deleting a release designers may already be running.

## Known limitations / TODO

- **macOS build is Apple Silicon (arm64) only.** It won't run on Intel Macs. Add an `x86_64-apple-darwin` matrix row (and pin its ffmpeg SHA) when needed — see EPIC-12.
- **Windows ffmpeg SHA is not pinned yet** (bootstrap mode in `scripts/download-ffmpeg.mjs`). Capture the printed SHA and commit it into `TARGETS["win32-x64"].expected` so Windows builds are verified.
- **Builds are unsigned** until code signing is wired (EPIC-12.3). Users see Gatekeeper ("unidentified developer") on macOS and SmartScreen on Windows on first launch — see [Installing an unsigned build](#installing-an-unsigned-build-for-designers) for the one-time bypass. Signing/notarization secrets plug into the commented `env:` block in `release.yml`.

## Troubleshooting

- **`tag vX.Y.Z already exists`** — that version was already cut; bump again (`pnpm release patch`).
- **`working tree not clean` / `on branch …`** — commit/stash and switch to `main` first.
- **CI install fails on the lockfile** — run `pnpm install` locally, commit the updated `pnpm-lock.yaml`, and re-tag.
- **No installers on the build** — check the Actions log for the ffmpeg-sidecar or `tauri build` step; a failed sidecar fetch (network/SHA) is the usual culprit.
