# Open issues

Парковка известных follow-up задач после Wave 6. Каждый тикет — отдельный `.md` с контекстом, acceptance criteria и ссылками на затронутые файлы. Берётся в работу по triger'у из таблицы ниже.

| # | Тикет | Effort | Trigger |
|---|-------|--------|---------|
| 001 | [Mirror ffmpeg binaries to Hetzner Object Storage](./001-mirror-ffmpeg-hetzner.md) | ~2h | Когда нужна zero-dependency на personal hosts (evermeet.cx / gyan.dev / johnvansickle.com) |
| 002 | [Apple Developer ID + notarisation](./002-apple-developer-id.md) | ~2h setup + $99/год | Перед раздачей `.dmg` жене/брату на macOS Sequoia |
| 003 | [Re-adopt race: in-flight flag for lock acquisition](./003-readopt-race-inflight-flag.md) | ~15min | Low-likelihood race, можно отложить до первого incident'а |
| 004 | [CI/CD matrix builds для multi-platform releases](./004-cicd-matrix-builds.md) | ~4h | Когда захочется automated releases вместо ручного `pnpm tauri build` |
| 005 | [Refactor: prompt-bearing-tab predicate + split PromptLibraryModal](./005-prompt-tab-refactors.md) | ~1h | Когда добавляется 3-й prompt-bearing tab kind (e.g. narration) OR browse UI обрастает фичами |
