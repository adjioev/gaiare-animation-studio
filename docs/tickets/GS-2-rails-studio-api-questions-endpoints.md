# GS-2: Rails — Studio API v1 questions endpoints

**Phase:** 1
**Effort:** 1 day
**Depends on:** GS-1 (auth concern must exist)
**Repo:** `gaiare-project/gaiare` (Rails)

## Summary

REST JSON endpoints under `/api/v1/studio/*` that the Studio desktop app
calls to browse and fetch questions. Filter by country, cognitive_type,
animation status. Pagination. Uses `ApiTokenAuthenticatable` from GS-1.

## Why a new namespace (not reuse `/api/v1`)

The existing `/api/v1/*` (mobile, web) is session-authenticated. Mixing
bearer-token auth into it risks breaking existing clients. A parallel
`/api/v1/studio/*` namespace keeps concerns separate and lets future Studio
endpoints evolve without coupling to mobile.

## Acceptance criteria

- [ ] `Api::V1::Studio::BaseController < ApplicationController`:
  - `include ApiTokenAuthenticatable` (from GS-1)
  - `before_action :require_admin_token` — verifies `Current.user.admin?`
  - `respond_to :json` only
  - Standard error JSON shape: `{ error: { code, message } }`
- [ ] `GET /api/v1/studio/questions` — paginated list:
  - Query params:
    - `country_code` (string, e.g. `"GE"`, `"AM"`) — filter
    - `cognitive_type` (string) — filter against `Question.cognitive_type`
      enum. Architect note: actual enum values are `textual` /
      `situational` / `procedural` / `signquiz` / `medical` (NOT `signs`)
    - `has_animation` (boolean as `"true"` / `"false"`) — `where.not(answer_video_url: nil)` /
      `where(answer_video_url: nil)`
    - `q` (string) — full-text search against `text` field, optional
    - `page` (int, default 1), `per_page` (int, default 20, max 100)
  - Response:
    ```json
    {
      "data": [
        {
          "id": 1234,
          "external_ref": "14",
          "country_code": "GE",
          "text": "...",
          "image_url": "https://hel1.your-objectstorage.com/...",
          "cognitive_type": "procedural",
          "answer_video_url": null,
          "last_published_at": null,
          "topic": "right_of_way",
          "subtopic": "intersection_priority"
        }
      ],
      "meta": { "page": 1, "per_page": 20, "total": 412, "total_pages": 21 }
    }
    ```
  - Order: most-recently-updated first (matches likely workflow: "what
    haven't I done yet?")
- [ ] `GET /api/v1/studio/questions/:id` — single question detail:
  - Same fields as list + full prompt history (if relevant), parent
    relationships, anything else useful for context
  - `id` accepts either DB id (integer) OR `"<country_code>/<external_ref>"`
    composite (e.g. `"GE/14"`) — composite is the Studio-friendly key
- [ ] `GET /api/v1/studio/countries` — list of available countries
  - Response: `{ data: [{ code: "GE", name: "Georgia" }, ...] }`
  - Used by Studio Settings + browse filter
- [ ] All endpoints return 401 if token missing / revoked / invalid
- [ ] All endpoints return 403 if user is not admin
- [ ] Tests: list with each filter, single fetch by id and by composite,
      pagination, auth (missing token, revoked, non-admin), 404 on
      nonexistent

## Implementation notes

- Pagination: use existing pagination library if Rails already has one
  (Kaminari / Pagy). Otherwise hand-roll — `offset(per_page * (page-1)).limit(per_page)`.
- `image_url` field: Question already has the source image stored on
  Hetzner per CLAUDE.md ("source image" — workspace anchor). Surface its
  full URL so Studio can download.
- `topic` / `subtopic`: pull from `question_focus_json` field per existing
  app pattern, or join through tags.
- Search (`q` param): if PostgreSQL has trigram indexes, use ILIKE. If
  not, just `where("text ILIKE ?", "%#{sanitized}%")`. Rails-stack issues
  here belong to the app's existing search infra — don't reinvent.
- Avoid N+1: eager-load whatever Question's serializer touches
  (`.includes(:country, :question_focus_json…)` — actual associations
  depend on Question's current schema).
- Serializer: ActiveModel::Serializer if present, otherwise plain
  `as_json` in controller. Keep it consistent with existing API.

## Files touched

**New:**
- `app/controllers/api/v1/studio/base_controller.rb`
- `app/controllers/api/v1/studio/questions_controller.rb`
- `app/controllers/api/v1/studio/countries_controller.rb`
- `app/serializers/api/v1/studio/question_serializer.rb` (if using AMS)
- `test/controllers/api/v1/studio/questions_controller_test.rb`
- `test/controllers/api/v1/studio/countries_controller_test.rb`

**Modified:**
- `config/routes.rb` — add the namespace:
  ```ruby
  namespace :api do
    namespace :v1 do
      namespace :studio do
        resources :questions, only: [:index, :show]
        resources :countries, only: [:index]
      end
    end
  end
  ```

## Test plan

- [ ] `curl -H "Authorization: Bearer $TOKEN" http://localhost:3011/api/v1/studio/questions?country_code=GE&cognitive_type=procedural&per_page=5` returns 5 procedural Georgian Q's
- [ ] `has_animation=false` returns only unpublished
- [ ] `q=intersection` returns matches (verify case-insensitivity)
- [ ] `curl ... /api/v1/studio/questions/GE/14` returns Q14 details
- [ ] Missing token → 401
- [ ] Non-admin user's token → 403
- [ ] Invalid country_code → 200 with empty `data: []` (not 400)
- [ ] Page beyond total_pages → 200 with empty data, meta still reflects total

## Out of scope

- POST / PATCH / DELETE on questions (publish endpoints land in GS-6)
- WebSocket / push for new questions (manual refresh OK)
- Question categories endpoint (Studio doesn't need it yet — MCP handles
  that in Phase 4)
