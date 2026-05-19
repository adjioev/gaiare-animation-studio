# Gaiare Animation Studio

Tauri desktop app that contractors use to produce the animated explainer
videos overlaying question images in the Gaiare driving-theory app.
Wan 2.2 i2v on Replicate, ffmpeg locally for frame extraction and
stitching, ElevenLabs narration (next phase).

For the product reasoning see
`gaiare-next-server/docs/animated-explainer-pipeline.md`.

## Run

```bash
pnpm install
pnpm tauri dev      # opens the desktop app + Vite dev server
```

Requirements:

- Node 20+ and pnpm
- Rust toolchain (`rustup default stable`)
- `ffmpeg` and `ffprobe` on `PATH` (`brew install ffmpeg` on macOS,
  `apt install ffmpeg` on Linux, `winget install ffmpeg` on Windows)
- `.env` with `REPLICATE_API_TOKEN` set (see `.env.example`)

Working files land under the user's Documents directory, in a folder
named via Settings (default `gaiare-animation-studio`).

## What it does today

- **Workspace per question** (`q14`, `q15`, …) with persistent
  `workspace.json`, asset gallery, multi-tab document model
- **Generate Clip** tab — Wan 2.2 i2v fast through a Rust proxy command
- **Extract Frame** tab — native `<video>` scrubber + ffmpeg
- **Asset gallery** — image / video sections, source asset protected
- **Advisory workspace locks** (`workspace.lock.<contractorId>`) so
  teammates editing the same q at the same time see a warning
- **Cross-platform** — uses `$DOCUMENT` (Tauri's known-folder
  abstraction) and `documentDir() + join()` for path composition.
  Tested on macOS; Windows readiness pending an ffmpeg sidecar bundle.

## Architecture

- **Tauri 2** runtime + plugins: `shell` (ffmpeg subprocess), `http`
  (CDN downloads from Replicate / Hetzner), `fs` (workspace dir),
  `dialog`.
- **React 19 + Vite + Tailwind v4** renderer.
- **Rust commands** for Replicate (`src-tauri/src/replicate.rs`) — the
  API token never enters the JS bundle. `dotenvy` loads the same `.env`
  the Vite renderer reads at dev time.

```
src/
├── App.tsx                          # workspace orchestration
├── components/
│   ├── AssetGallery.tsx             # sidebar, image / video sections
│   ├── TabStrip.tsx                 # VSCode-style document tabs
│   ├── SettingsModal.tsx
│   ├── ui.tsx
│   └── tabs/
│       ├── GenerateClipTab.tsx
│       └── ExtractFrameTab.tsx
└── lib/
    ├── settings.ts                  # workspaceFolderName + contractorId
    ├── workdir.ts                   # path helpers (BaseDirectory.Document)
    ├── workspace.ts                 # v2 schema: assets[] + tabs[]
    ├── lock.ts                      # per-contractor advisory locks
    ├── replicate.ts                 # thin wrapper over Rust commands
    └── ffmpeg.ts                    # extractFrame, probeDurationSeconds

src-tauri/
├── src/lib.rs                       # plugin bootstrap + invoke handlers
├── src/replicate.rs                 # Rust HTTPS proxy for Replicate
├── capabilities/default.json        # fs / http / shell allow-lists
└── tauri.conf.json
```

## Cloud sync caveats (Dropbox / iCloud / OneDrive)

Workspace locks are filesystem files, so they work only when contractors
share the same filesystem path. Three setups:

| Setup | Locks work? |
|---|---|
| Each contractor's own local `~/Documents/` (no sync) | ❌ No — locks invisible to each other |
| Shared via Dropbox / iCloud / OneDrive | ✅ Yes — sync propagates lock files. **Pick this for a real team.** |
| NAS / network drive mount | ✅ Yes, fastest visibility |

**Per-contractor lock filenames** (`workspace.lock.anna`,
`workspace.lock.dato`) avoid the cloud-sync conflict-file problem that
a single shared `workspace.lock` would have. Each contractor writes
only their own file; reading enumerates all of them.

**Important:** if you use cloud sync, **don't sync the mp4 / jpg files
in `qNN/` folders** — they're large and bandwidth-expensive. Either
configure the cloud provider to ignore those extensions, or move heavy
output to S3 (the production path).

## Security note (status: improved)

API tokens are now in Rust (loaded from `.env` via `dotenvy` at app
start). The renderer talks to Replicate only through Tauri commands
(`replicate_create_wan_prediction`, `replicate_get_prediction`,
`replicate_cancel_prediction`). Bundled JS does **not** contain the
token — verified by grepping the production build.

Remaining hardening for distribution to external contractors:

1. **Production builds with bundled secrets** — `pnpm tauri build`
   creates a binary that still includes the `dotenvy`-loaded env var if
   `.env` is shipped with it. For real distribution, either (a) require
   each contractor to supply their own `.env` post-install, (b) bake
   per-contractor tokens at build time, or (c) wire `gaiare-next-server`
   as the source of truth (recommended long-term).
2. **ffmpeg sidecar** — currently relies on the host install. Sidecar
   binary via `tauri-plugin-shell`'s sidecar mechanism is the Windows
   path of least resistance.
3. **`workspace.lock.*` is advisory only** — no kernel-level exclusion.
   The cloud-sync setup is the practical multi-contractor solution.

## Settings

Open the **⚙** button in the header. Two fields:

- **Workspace folder** — subfolder under the user's Documents.
  Constrained to Windows-safe names (no `< > : " / \ | ? *`, no
  Windows-reserved names like `CON`/`AUX`).
- **Contractor name** — advisory identity used on workspace locks and
  (future) audit logs. Without it, the Generate Clip workflow is
  blocked at the UI level.
