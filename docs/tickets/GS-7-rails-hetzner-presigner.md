# GS-7: Rails — Hetzner presigner integration

**Phase:** 2
**Effort:** 0.5 day
**Depends on:** GS-6 uses this
**Repo:** `gaiare-project/gaiare` (Rails)

## Summary

Service object that wraps `aws-sdk-s3` configured for Hetzner Object
Storage. Generates presigned PUT URLs for direct browser/desktop uploads.
Used by GS-6's `animation_upload_url` endpoint; structured to be reused
by future endpoints (source image upload, narration audio, etc.).

## Why a separate ticket

Reusable infrastructure. Other future endpoints (e.g. source image
upload for new questions, ElevenLabs narration storage) will need the
same presigner. Isolating it keeps GS-6 focused on the endpoint shape
and lets the storage concern evolve independently.

## Acceptance criteria

- [ ] `app/services/hetzner/presigner.rb` service object:
  - Initializer reads `HETZNER_S3_ENDPOINT`, `HETZNER_S3_BUCKET`,
    `HETZNER_S3_ACCESS_KEY`, `HETZNER_S3_SECRET_KEY`, `HETZNER_S3_REGION`
    from `ENV`. Fail fast on first instantiation if missing
    (`KeyError` with clear message).
  - Public method: `presign_put(object_key:, content_type:, ttl: 15.minutes)`
    returns `{ url: String, expires_at: Time, headers: Hash }`
  - Public method: `head_object(object_key:)` returns `{ size: Integer,
    content_type: String, last_modified: Time }` or raises
    `Hetzner::Presigner::NotFound`
  - Public method: `public_url(object_key:)` returns the canonical
    https URL the user-facing app (`gaiare.ge`, `gaiare-next-server`)
    would fetch from
- [ ] `Aws::S3::Client` configured with Hetzner's endpoint:
  ```ruby
  Aws::S3::Client.new(
    endpoint: ENV.fetch("HETZNER_S3_ENDPOINT"),
    access_key_id: ENV.fetch("HETZNER_S3_ACCESS_KEY"),
    secret_access_key: ENV.fetch("HETZNER_S3_SECRET_KEY"),
    region: ENV.fetch("HETZNER_S3_REGION"),
    force_path_style: true # Hetzner needs path-style addressing
  )
  ```
- [ ] Presigned URLs include `Content-Type` in the signed headers so the
      client MUST send the matching header (prevents `Content-Type`
      mismatch resulting in wrong stored mime). Returned `headers` hash
      tells the client exactly what to send.
- [ ] `aws-sdk-s3` gem added if not already present
- [ ] Unit tests with `WebMock` stubbing Hetzner endpoint:
  - Presign generates expected URL shape
  - `head_object` returns parsed metadata
  - `head_object` raises NotFound when Hetzner returns 404
  - Missing env raises informative error at init

## Implementation notes

- Endpoint URL format example: `https://hel1.your-objectstorage.com`
  (Hetzner Helsinki). Bucket is then `gaiare-media` per CLAUDE.md memory.
- `force_path_style: true` — Hetzner uses path-style (`https://endpoint/bucket/key`)
  not virtual-hosted (`https://bucket.endpoint/key`).
- TTL choice: 15 minutes is the architect-recommended value. Long enough
  for slow uploads of 50-100MB videos, short enough that a leaked URL
  isn't usefully reusable.
- For the `public_url` method, the canonical URL uses the bucket-host
  form: `https://hel1.your-objectstorage.com/gaiare-media/<object_key>`.
  Verify by hitting an existing object (q14 source image).
- The Aws::S3 client is expensive to construct (network handshake on
  first request). Memoize at module level or via Singleton — singleton
  is fine for Rails app context.

## Files touched

**New:**
- `app/services/hetzner/presigner.rb`
- `test/services/hetzner/presigner_test.rb`

**Modified:**
- `Gemfile` (add `aws-sdk-s3` if missing) + `Gemfile.lock`
- `config/application.rb` or `config/initializers/aws.rb` — global
  configuration

## Test plan

- [ ] In Rails console:
  ```ruby
  presigner = Hetzner::Presigner.new
  result = presigner.presign_put(object_key: "test/foo.txt", content_type: "text/plain")
  ```
  Upload with cURL using the returned URL:
  ```bash
  curl -X PUT -H "Content-Type: text/plain" --data "hello" "$URL"
  ```
  → 200 OK
- [ ] `presigner.head_object(object_key: "test/foo.txt")` returns
      `{ size: 5, content_type: "text/plain" }`
- [ ] `presigner.head_object(object_key: "nonexistent")` raises NotFound
- [ ] Unset `HETZNER_S3_ACCESS_KEY` and reload → init raises informative
      `KeyError`
- [ ] Public URL fetched via curl is publicly readable
- [ ] Presign URL after 16 minutes returns Hetzner 403 (expired)

## Out of scope

- Bucket lifecycle policies (auto-delete after N days) — manual or
  separate ticket
- Server-side encryption (SSE-C / KMS) — Hetzner support varies, skip
  for internal tool
- ACL management (we publish public-read objects; bucket policy controls
  read access globally)
- CDN integration (Cloudfront / Cloudflare in front of Hetzner) —
  separate future concern
