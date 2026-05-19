# 001 — Mirror ffmpeg binaries to Hetzner Object Storage

**Status:** Open
**Effort:** ~2h
**Priority:** Medium (security hygiene)
**Trigger:** Когда захочется zero-dependency на personal hosts

## Контекст

`scripts/download-ffmpeg.mjs` сейчас тянет ffmpeg/ffprobe с третьих хостов:

| Platform | Host |
|---|---|
| macOS | `evermeet.cx` (personal site of one maintainer) |
| Windows | `gyan.dev` (personal site of one maintainer) |
| Linux | `johnvansickle.com` (personal site of one maintainer) |

SHA-256 pinning (Wave 6) защищает от silent compromise — если upstream подменит бинарь, build упадёт с явной ошибкой. Но это не защищает от **availability**: если host лёг или maintainer перестал поддерживать сборки — наш `pnpm tauri build` встанет полностью.

## Решение

Зазеркалить пинованные версии бинарей в Hetzner Object Storage, который уже используется для прода (`hel1.your-objectstorage.com/gaiare-static/`).

```
hel1.your-objectstorage.com/gaiare-static/ffmpeg/
├── 7.1.1/
│   ├── ffmpeg-aarch64-apple-darwin.zip
│   ├── ffprobe-aarch64-apple-darwin.zip
│   ├── ffmpeg-x86_64-apple-darwin.zip
│   ├── ffprobe-x86_64-apple-darwin.zip
│   ├── ffmpeg-x86_64-pc-windows-msvc.zip
│   └── ffmpeg-x86_64-unknown-linux-gnu.tar.xz
```

## Acceptance criteria

- [ ] Скачать текущие пинованные версии (matching captured SHAs) и залить в Hetzner под версией `7.1.1/`
- [ ] Обновить `TARGETS` в `scripts/download-ffmpeg.mjs` — заменить evermeet.cx/gyan.dev/johnvansickle.com URLs на Hetzner-mirror URLs
- [ ] Sanity check: `rm -rf src-tauri/binaries/* && pnpm setup-ffmpeg` — должно скачать с Hetzner и SHA verify
- [ ] CI build на всех 4 платформах (см. issue #004) использует mirror'д URLs
- [ ] Документировать процесс обновления версии: `bin/refresh-ffmpeg.sh <version>` — fetch upstream → verify SHAs match captured → re-upload to Hetzner

## Связанные файлы

- `scripts/download-ffmpeg.mjs` — `TARGETS` constant (lines 45-89)
- `src-tauri/tauri.conf.json` — `externalBin` paths

## Риски

- Hetzner Object Storage не безлимитный — но ffmpeg бинари ~50MB total × 4 platform = 200MB, мизер
- Mirror тоже может протухнуть — но это **наш** хост, контроль полный
- SHA pinning остаётся работать — Hetzner-сторона должна вернуть тот же байт-в-байт zip с теми же SHAs
