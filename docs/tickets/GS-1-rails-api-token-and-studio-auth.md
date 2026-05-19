# GS-1: Rails — ApiToken model + Studio auth controller

**Phase:** 1
**Effort:** 1 day
**Depends on:** —
**Repo:** `gaiare-project/gaiare` (Rails)

## Summary

Add a long-lived bearer-token authentication path for the Studio desktop app.
Token issuance uses a one-time-code exchange flow so the secret never travels
in a redirect URL. Tokens are stored bcrypt-hashed; the plaintext is shown
once at issue and never persisted.

## Why this design (not direct redirect token)

A direct redirect to `gaiare-studio://auth?token=<token>` would let any web
page open the URL scheme with a fake token. The one-time-code exchange
(initiate → browser authorise → code → exchange → token) means the token
never appears in a URL — only a short-lived single-use code does. The
exchange endpoint verifies code + state before issuing the real token.

## Acceptance criteria

- [ ] `ApiToken` model: `belongs_to :user`, columns `token_digest:string`,
      `last_used_at:datetime`, `revoked_at:datetime`, `created_at`,
      `updated_at`. Token digest is bcrypt-hashed.
- [ ] `StudioAuthCode` model (or in-memory cache w/ TTL — pick simpler):
      stores `code:string` (random 32-char), `state:string`,
      `user_id:bigint`, `expires_at:datetime`. Single-use: deleted on
      exchange.
- [ ] `ApiTokenAuthenticatable` concern reads `Authorization: Bearer <token>`,
      looks up by digest, sets `Current.user`, updates `last_used_at`.
- [ ] `POST /studio/auth/initiate` — accepts `{ state: <random> }` from the
      Studio app, returns `{ authorize_url: "/studio/auth?state=..." }`.
      Studio will open this URL in the system browser.
- [ ] `GET /studio/auth?state=<state>` — if user not logged in, redirect to
      `/sign_in?return_to=/studio/auth?state=...`. If logged in, render an
      "Authorize Animation Studio?" page with Approve / Deny buttons.
- [ ] `POST /studio/auth/approve` — Approve handler: generates `auth_code`,
      stores `{code, state, user_id}`, redirects to
      `gaiare-studio://auth?code=<code>&state=<state>`.
- [ ] `POST /studio/auth/exchange` — accepts `{ code, state }`, verifies
      both, deletes the code, generates a fresh token, returns
      `{ token: <plaintext>, user: {email, name} }`. Token plaintext is
      returned ONLY here, never again.
- [ ] Admin can view + revoke tokens via Avo: list of own tokens with
      `last_used_at`, "Revoke" button sets `revoked_at`.
- [ ] Revoked tokens reject with 401 even if presented.
- [ ] Tests: model tests for ApiToken (digest, validation), controller
      tests for full flow (initiate → exchange → use token on
      authenticated endpoint).

## Implementation notes

- Reuse existing Devise / Sorcery / Rails-native auth — the user must be
  logged in to reach `/studio/auth`. Just check `current_user.present?`.
- `auth_code` random — `SecureRandom.urlsafe_base64(24)`. 10 min TTL.
- `token` random — `SecureRandom.urlsafe_base64(32)` (43 chars after base64).
- `token_digest` via `BCrypt::Password.create(token, cost: 8)` — cost 8 is
  fine for 3-user scale and keeps lookup fast (~5ms).
- For lookup-by-token, store a non-bcrypt index hash too if needed
  (`Digest::SHA256.hexdigest(token)`) so we don't bcrypt-compare every
  token in the table on each request. Add `token_lookup_hash:string,
  index: true` column. Bcrypt digest still validates the candidate.
- Concern lives at `app/controllers/concerns/api_token_authenticatable.rb`.
- Auth pages: `app/views/studio_auth/show.html.erb`. Plain Bootstrap-ish
  layout, no Avo chrome.
- Routes:
  ```ruby
  scope "/studio/auth" do
    post "/initiate", to: "studio_auth#initiate"
    get "/", to: "studio_auth#show"
    post "/approve", to: "studio_auth#approve"
    post "/exchange", to: "studio_auth#exchange"
  end
  ```

## Files touched

**New:**
- `db/migrate/<ts>_create_api_tokens.rb`
- `db/migrate/<ts>_create_studio_auth_codes.rb`
- `app/models/api_token.rb`
- `app/models/studio_auth_code.rb`
- `app/controllers/studio_auth_controller.rb`
- `app/controllers/concerns/api_token_authenticatable.rb`
- `app/views/studio_auth/show.html.erb`
- `app/views/studio_auth/exchange_complete.html.erb` (optional info page)
- `test/models/api_token_test.rb`
- `test/controllers/studio_auth_controller_test.rb`

**Modified:**
- `config/routes.rb`
- Avo resource for ApiToken (auto-detected if you let Avo discover) or
  `app/avo/resources/api_token.rb`

## Test plan

- [ ] Studio opens `http://localhost:3011/studio/auth?state=test123`
- [ ] Not logged in → redirect to sign-in, after sign-in redirect back
- [ ] Logged in → Authorize page renders with Approve / Deny buttons
- [ ] Click Approve → browser navigates to `gaiare-studio://auth?code=...`
      (with the macOS scheme handler not yet wired in this ticket — just
      verify the redirect URL is correct via DevTools)
- [ ] `POST /studio/auth/exchange` with valid code → returns `{ token }`
- [ ] Same code on a 2nd exchange → 410 Gone (already used)
- [ ] Wrong state on exchange → 400 Bad Request
- [ ] Expired code (manually backdate `expires_at`) → 410
- [ ] Authenticated GET to a protected `/api/v1/studio/*` endpoint with the
      token works; with revoked token → 401
- [ ] Avo: list own tokens, revoke, confirm 401 from Studio after

## Out of scope

- Refresh-token rotation (long-lived single token is fine for 3 users)
- Per-token scopes (every Studio token has full admin access; same as the
  user's session)
- Auto-expiry via `expires_at` on ApiToken (we use revocation instead)
