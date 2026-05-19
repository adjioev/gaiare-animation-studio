# Rails ↔ Studio integration — tickets

JIRA-style tickets for connecting the Tauri Studio app to the Rails main app
(`/Users/adjioev/sandbox/gaiare-project/gaiare`). Reviewed by architect.

Each ticket is **one branch / one PR**. Order matters — dependencies are
explicit. Estimated effort assumes the contractor knows both stacks.

## Phasing

| Phase | Goal | Tickets | Effort |
|---|---|---|---|
| 1 | Magic-link auth + browse-and-open from Rails | GS-1 → GS-5 | ~4 days |
| 2 | Publish generated clips to Rails | GS-6 → GS-8 | ~2 days |
| 3 | Country + external_ref composite key | GS-9 | 0.5 day |
| 4 | Studio AI uses Rails MCP for context | GS-10 → GS-11 | ~3 days |

Total: **~9-10 days** of focused work for the full integration.

## Dependency graph

```
GS-1 (Rails ApiToken + auth ctrl)
  └─ GS-3 (Studio deep-link + keychain + Settings)
       └─ GS-4 (Studio Rust Rails proxy)
            └─ GS-5 (Browse + open modal)

GS-2 (Rails questions API) ──┘  (also feeds GS-4)

GS-6 (Rails publish endpoints) ── GS-7 (Hetzner presigner) ── GS-8 (Studio publish button)

GS-9 (Country namespace) — independent, can land any time after Phase 1

GS-10 (MCP bridge) ── GS-11 (skill prompt update)
```

## Tickets

### Phase 1 — Auth + Browse

- [GS-1: Rails — ApiToken model + Studio auth controller](./GS-1-rails-api-token-and-studio-auth.md) — 1 day
- [GS-2: Rails — Studio API v1 questions endpoints](./GS-2-rails-studio-api-questions-endpoints.md) — 1 day
- [GS-3: Studio — deep-link, OS keychain, Connect-to-Rails Settings](./GS-3-studio-deep-link-keychain-settings.md) — 1 day
- [GS-4: Studio — Rust Rails proxy commands](./GS-4-studio-rust-rails-proxy.md) — 0.5 day
- [GS-5: Studio — browse-and-open modal replaces New Workspace](./GS-5-studio-browse-and-open-modal.md) — 0.5 day

### Phase 2 — Publish

- [GS-6: Rails — `answer_video_url` migration + publish endpoints](./GS-6-rails-answer-video-url-and-publish-endpoints.md) — 0.5 day
- [GS-7: Rails — Hetzner presigner integration](./GS-7-rails-hetzner-presigner.md) — 0.5 day
- [GS-8: Studio — Publish button + signed-URL upload](./GS-8-studio-publish-button-and-upload.md) — 1 day

### Phase 3 — Country namespace

- [GS-9: Studio — workspace dir migration v2 → v3 + country selector](./GS-9-studio-country-namespace-migration.md) — 0.5 day

### Phase 4 — Studio AI ↔ MCP

- [GS-10: Studio — MCP bridge + function-calling loop](./GS-10-studio-mcp-bridge.md) — 2 days
- [GS-11: Studio — skill prompt update for MCP tools](./GS-11-studio-skill-prompt-mcp-update.md) — 0.5 day

## Conventions

- **Branch name**: `feat/gs-<n>-<slug>` (e.g. `feat/gs-3-deep-link-keychain`)
- **Commit message**: `feat(GS-<n>): <summary>`
- **PR**: title prefixed with `GS-<n>:`, body links back to the ticket file
- **Acceptance criteria**: every box must be checked before merge
- **Test plan**: prefer manual end-to-end tests on local Rails (`http://localhost:3011`) + local Studio

## Out of scope (future)

- gaiare-next-server integration (already reads `answer_video_url`; no changes
  needed for Phase 1-2)
- Multi-contractor real-time locking via Rails (current per-machine workspace
  locks acceptable for 3 users)
- Rollback / version history for published animations (architect: "over-
  engineering at this scale"; `last_published_at` audit is enough)
- Windows / Linux deep-link parity (Phase 1 ships macOS-only)
- Production Apple Developer ID signing (separate ticket — see
  `docs/issues/002-apple-developer-id.md`)
