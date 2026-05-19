# GS-6: Rails — `answer_video_url` migration + publish endpoints

**Phase:** 2
**Effort:** 0.5 day
**Depends on:** GS-1 (auth concern), GS-2 (API base controller)
**Repo:** `gaiare-project/gaiare` (Rails)

## Summary

Add the `answer_video_url` column to Question (the explanation video that
plays after a user answers — continuation of the question image). Wire
two endpoints: one returns a presigned PUT URL to Hetzner so Studio
uploads the bytes directly; the other finalises by setting the URL
plus `last_published_at` on the question.

## Acceptance criteria

- [ ] Migration `<ts>_add_answer_video_url_to_questions.rb`:
  - `add_column :questions, :answer_video_url, :string`
  - `add_column :questions, :last_published_at, :datetime`
  - `add_column :questions, :last_published_by_id, :bigint, null: true,
    foreign_key: { to_table: :users }`
  - `add_index :questions, :last_published_at`
- [ ] Question model:
  - Validate `answer_video_url` format (must be a Hetzner Object Storage
    URL — regex match against the bucket host)
  - Scope: `scope :with_animation, -> { where.not(answer_video_url: nil) }`
- [ ] `POST /api/v1/studio/questions/:id/animation_upload_url`:
  - Auth: `ApiTokenAuthenticatable` + admin check
  - Accepts `:id` either as DB id OR composite `<country_code>/<external_ref>`
    (mirrors GS-2)
  - Body: optional `{ content_type: "video/mp4" }` (defaults to that)
  - Returns:
    ```json
    {
      "upload_url": "https://hel1.your-objectstorage.com/...",
      "object_key": "georgia/animations/q14.mp4",
      "expires_at": "...",
      "headers": { "Content-Type": "video/mp4" }
    }
    ```
  - Presign TTL: 15 minutes (architect)
  - File naming convention: `{country_code.downcase}/animations/q{external_ref}.mp4`
    — overwrites on republish. No versioning per architect.
- [ ] `PATCH /api/v1/studio/questions/:id/animation`:
  - Auth: same as above
  - Body:
    ```json
    {
      "object_key": "georgia/animations/q14.mp4",
      "duration_sec": 5.2,
      "prompt": "...",
      "parent_asset_external_refs": []
    }
    ```
  - Action:
    1. HEAD request to Hetzner to verify the object exists and has
       sensible Content-Type / Content-Length (>0, <500MB)
    2. Construct public URL from `object_key`
    3. Update Question: `answer_video_url`, `last_published_at = Time.current`,
       `last_published_by_id = Current.user.id`
  - Returns updated Question JSON (same shape as GS-2 detail)
  - On HEAD failure: 422 with `"object_not_found"` — Studio retries the
    upload
- [ ] Idempotency: re-publishing same question with same key is a no-op
      that still bumps `last_published_at` (so audit log shows the
      attempt)
- [ ] Tests: model scope, both endpoints (success, validation failures,
      HEAD-check failures, auth failures)

## Implementation notes

- Hetzner config: `HETZNER_S3_ENDPOINT`, `HETZNER_S3_BUCKET`,
  `HETZNER_S3_REGION` env vars. Architect noted `aws-sdk-s3` works with
  Hetzner via `endpoint` override.
- The actual presign logic lives in GS-7 (`Hetzner::Presigner`). This
  ticket calls that service.
- HEAD verification: use `Aws::S3::Client` `head_object`. 5-second
  timeout. Catch `Aws::S3::Errors::NotFound` → 422.
- Don't trust `Content-Type` from Studio — verify Hetzner's returned
  header matches `video/mp4`.
- `last_published_by_id` enables future audit views (Avo: "Q14 last
  published by anna on 2026-06-12"). Soft requirement — nullable so
  earlier-published rows from any pre-existing data still work.

## Files touched

**New:**
- `db/migrate/<ts>_add_answer_video_url_to_questions.rb`
- `app/controllers/api/v1/studio/animations_controller.rb`
- `test/controllers/api/v1/studio/animations_controller_test.rb`

**Modified:**
- `app/models/question.rb` — validation + scope
- `config/routes.rb` — add member routes:
  ```ruby
  resources :questions, only: [:index, :show] do
    member do
      post :animation_upload_url
      patch :animation
    end
  end
  ```

## Test plan

- [ ] Migration runs cleanly on dev. Rollback is safe.
- [ ] `POST /api/v1/studio/questions/GE/14/animation_upload_url` returns
      a valid presign URL. cURL upload with that URL succeeds.
- [ ] `PATCH .../animation` with the resulting `object_key` updates the
      Question. Re-fetch via GS-2 detail endpoint confirms
      `answer_video_url` is set.
- [ ] Repeat upload + finalise → `last_published_at` updates (idempotent
      success).
- [ ] HEAD-check failure (delete object before PATCH) → 422.
- [ ] Non-admin token → 403.
- [ ] Object > 500 MB → reject before saving URL.

## Out of scope

- Object storage delete on de-publish (republish overwrites; explicit
  delete is rare and can be done manually)
- Multi-format support (mp4 only for now; future webm / hls is separate)
- Webhook to gaiare-next-server (architect: no changes needed there;
  next-server reads `answer_video_url` from Rails API as it already does)
- Animation history table (architect: over-engineering)
