# 002 — Apple Developer ID + notarisation

**Status:** Open
**Effort:** ~2h setup + $99/год
**Priority:** High (blocker для distribution)
**Trigger:** Перед раздачей `.dmg` жене/брату на macOS Sequoia

## Контекст

Сейчас собранный `.dmg` через `pnpm tauri build` — **unsigned**. Sequoia (macOS 15+) ужесточила Gatekeeper: правый-клик → Open уже не достаточно, нужен notarised executable. Без подписи жена/брат увидят:

> "gaiare-animation-studio.app" is damaged and can't be opened.
> You should move it to the Trash.

Это даже не корректное сообщение — приложение не damaged, просто unsigned. Но обойти это пользователю невозможно без `sudo spctl --master-disable`, что мы не имеем права просить.

## Решение

Apple Developer Program account → Developer ID Application certificate → notarisation flow в `pnpm tauri build`.

### Steps

1. **Apple Developer Program enrollment** ($99/год) — https://developer.apple.com/programs/
   - Подписка на personal account `djioev@gmail.com`
   - Verification может занять до 48ч (Apple вручную проверяет, особенно для individuals)

2. **Developer ID Application certificate**
   - Xcode → Settings → Accounts → Manage Certificates → `+` → Developer ID Application
   - Экспорт `.p12` для использования в CI (см. issue #004)

3. **App-specific password для notarytool**
   - https://appleid.apple.com → Sign-In and Security → App-Specific Passwords
   - Сохранить в `~/.gaiare/.env` как `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`

4. **Tauri config** — `src-tauri/tauri.conf.json` → `bundle.macOS`:
   ```json
   {
     "macOS": {
       "signingIdentity": "Developer ID Application: Alex Djioev (TEAMID)",
       "providerShortName": "TEAMID",
       "hardenedRuntime": true,
       "entitlements": "entitlements.plist"
     }
   }
   ```

5. **Entitlements** — нужны для sidecar ffmpeg, network access:
   ```xml
   <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
   <key>com.apple.security.cs.disable-library-validation</key><true/>
   <key>com.apple.security.network.client</key><true/>
   ```

6. **Notarisation в build script**
   ```bash
   pnpm tauri build
   xcrun notarytool submit "src-tauri/target/release/bundle/dmg/*.dmg" \
     --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" \
     --wait
   xcrun stapler staple "src-tauri/target/release/bundle/dmg/*.dmg"
   ```

## Acceptance criteria

- [ ] Apple Developer account активен
- [ ] Developer ID Application certificate в keychain
- [ ] `.env` содержит `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`
- [ ] `pnpm tauri build` на mac arm64 производит signed `.dmg`
- [ ] `codesign --verify --deep --strict src-tauri/target/release/bundle/macos/*.app` → exit 0
- [ ] `spctl --assess --verbose=4 src-tauri/target/release/bundle/macos/*.app` → "accepted"
- [ ] Жена скачивает `.dmg` со свежего user account на Sequoia → открывается без warnings

## Связанные файлы

- `src-tauri/tauri.conf.json`
- (новый) `src-tauri/entitlements.plist`
- (новый) `scripts/sign-and-notarise.sh`

## Риски

- Apple verification может занять 48ч — заложить буфер перед раздачей
- $99 рекуррентно — если account expire'нет, существующие подписи перестают валидиться через ~1 год
- App-specific password можно случайно закоммитить — обязательно через `.env`, проверить `.gitignore`
- Sidecar ffmpeg могут потребовать `hardenedRuntime` exceptions — посмотреть после первой попытки
