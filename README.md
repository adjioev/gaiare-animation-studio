# Gaiare Animation Studio

Tauri desktop app for producing the animated explainer videos that overlay
question images in the Gaiare driving-theory app. AI-first generation
(Wan 2.2 i2v on Replicate), human review with natural-language
corrections, ffmpeg stitching, ElevenLabs narration.

For the product reasoning behind these videos see
`gaiare-next-server/docs/animated-explainer-pipeline.md`.

## Status

MVP — local single-question workflow. One screen, five steps:
1. Download source image
2. Generate clip 1 (Replicate)
3. Extract mid-frame (ffmpeg)
4. Generate clip 2 (Replicate)
5. Stitch into silent master (ffmpeg)

Narration (ElevenLabs) + S3 upload + queue integration with
`gaiare-next-server` land in subsequent iterations.

## Requirements

- Node 20+ and pnpm
- Rust toolchain (`rustup default stable`)
- `ffmpeg` on PATH (`brew install ffmpeg` on macOS)
- A `.env` file with `REPLICATE_API_TOKEN` set (see `.env.example`)

## Run

```bash
pnpm install
pnpm tauri dev   # spawns the desktop app + Vite dev server
```

Working files are written to `~/Documents/gaiare-animation-studio/q{external_ref}/`.

## Architecture

- **Tauri 2.0** runtime + plugins: `shell` (ffmpeg subprocess), `http`
  (Replicate / ElevenLabs), `fs` (working dir), `dialog`.
- **React 19 + Vite + Tailwind v4** frontend.
- **No Rust commands yet** — all logic lives in TypeScript for the MVP.
  Future: move API tokens out of the client bundle by adding
  `#[tauri::command]` proxies (or routing via `gaiare-next-server`).

## Layout

```
src/
├── App.tsx              # five-step workflow UI
├── App.css              # tailwind import + dark scheme
└── lib/
    ├── replicate.ts     # Wan i2v fast client (Tauri http plugin)
    ├── ffmpeg.ts        # extract / trim / concat / mux (Tauri shell plugin)
    ├── workdir.ts       # ~/Documents/gaiare-animation-studio/<q>/
    └── promptTemplates.ts # q14 known-good prompts + reusable templates

src-tauri/
├── src/lib.rs           # plugin bootstrap only
├── capabilities/        # fs / http / shell allowlists
├── Cargo.toml
└── tauri.conf.json
```

## Security note

`.env` secrets (REPLICATE_API_TOKEN etc.) are read by Vite at build/dev
time and baked into the client JS bundle via `import.meta.env`. Fine for
a personal dev tool, **NOT fine** for installer builds distributed to
contractors. Before shipping installers:

1. Move the Replicate / ElevenLabs calls into Rust commands
   (`#[tauri::command] async fn run_wan(...)`).
2. Read secrets from the OS keychain via `tauri-plugin-stronghold`.
3. Or — preferred — proxy through `gaiare-next-server` so secrets stay
   on Vercel and the desktop app only carries a Clerk JWT.
