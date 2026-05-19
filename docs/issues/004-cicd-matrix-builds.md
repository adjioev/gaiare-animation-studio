# 004 — CI/CD matrix builds для multi-platform releases

**Status:** Open
**Effort:** ~4h
**Priority:** Medium (зависит от scale)
**Trigger:** Когда захочется automated releases вместо ручного `pnpm tauri build`

## Контекст

Сейчас `.dmg` собирается локально на mac arm64 (M-series), и это всё что физически возможно собрать с одной машины без Apple Silicon Simulator + Parallels. Для жены/брата на arm64 mac этого хватает. Но как только:

- Брат купит mac Intel → нужен `x86_64-apple-darwin` build
- Кто-то захочет Windows version → `x86_64-pc-windows-msvc`
- Будущий Linux contractor → `x86_64-unknown-linux-gnu`

Локально каждую платформу не собрать. Нужен matrix CI.

## Решение

GitHub Actions workflow с matrix strategy:

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*']
jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-14   # arm64
            target: aarch64-apple-darwin
          - os: macos-13   # intel
            target: x86_64-apple-darwin
          - os: windows-latest
            target: x86_64-pc-windows-msvc
          - os: ubuntu-22.04
            target: x86_64-unknown-linux-gnu
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'pnpm' }
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: ${{ matrix.target }} }
      - run: pnpm install
      - run: pnpm tauri build --target ${{ matrix.target }}
      # macOS sign + notarise (см. issue #002)
      - if: startsWith(matrix.os, 'macos')
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: bash scripts/sign-and-notarise.sh
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.target }}
          path: src-tauri/target/${{ matrix.target }}/release/bundle/**/*
```

## Acceptance criteria

- [ ] `.github/workflows/release.yml` собирается на 4 OS matrix
- [ ] Tag-triggered: push `v0.2.0` → автоматически build + draft GitHub release с артефактами
- [ ] macOS targets signed + notarised (зависит от issue #002 — Apple Developer ID)
- [ ] ffmpeg sidecar binaries скачиваются с SHA verify в каждом job'е (`pnpm setup-ffmpeg`)
- [ ] CI secrets:
  - [ ] `REPLICATE_API_TOKEN` — для unit tests, если будут
  - [ ] `APPLE_*` — для notarisation (issue #002)
  - [ ] `WINDOWS_CERT_PASSWORD` — если решим signed exe для Windows (опционально)
- [ ] README обновлён: download links → GitHub releases вместо локально-собранного `.dmg`

## Связанные файлы

- (новый) `.github/workflows/release.yml`
- (новый) `.github/workflows/ci.yml` — typecheck + lint на каждый PR
- `package.json` — может потребоваться `release` script
- `scripts/sign-and-notarise.sh` — из issue #002

## Зависимости

- **Issue #002** (Apple Developer ID) — без него macOS builds будут unsigned, бесполезны для distribution
- **Issue #001** (Hetzner mirror) — без него `setup-ffmpeg` в CI бьёт upstream'ы каждый prod build, что risk их rate-limit'а

## Риски

- Матрица × 4 OS — каждый job ~10-15min на Tauri build, итого ~1ч wall time per release
- GitHub Actions free quota 2000 min/month для private repos — посчитать, не упрёмся ли
- Notarisation требует network к Apple — может flake'нуть, нужны retry в `sign-and-notarise.sh`
- Cargo cache между builds (`actions/cache` или `Swatinem/rust-cache`) — без него каждый build пересобирает crates с нуля, +5min job

## Будущее

После того как matrix builds работают, можно:

- Auto-update через [tauri-plugin-updater](https://v2.tauri.app/plugin/updater/) — Studio проверяет releases.json на Hetzner, предлагает update
- Release notes из git log → автоматически в GitHub release body
- Telegram/Slack webhook: уведомление команде когда release готов
