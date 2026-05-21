//! Rails Studio API proxy.
//!
//! The bearer token lives in the OS keychain (macOS Keychain), never in
//! the JS bundle. JS hands the token to `rails_connect` exactly once (on
//! paste); after that the proxy commands read it from the keychain when
//! making requests. Mirrors the replicate.rs / llm.rs threat model: the
//! secret stays in this process.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use keyring::Entry;
use reqwest::multipart;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::fs;
use url::Url;

use crate::safe_path::assert_safe_document_path;

const KEYCHAIN_SERVICE: &str = "gaiare-animation-studio.rails-token";

/// In-memory token cache, keyed by normalised server URL. Without it every
/// API request reads the keychain, and an unsigned dev binary re-prompts
/// for the login password on each read. With it the keychain is read at
/// most once per server per app session. The token never leaves this
/// process (same trust boundary as the keychain).
static TOKEN_CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn cache_key(server_url: &str) -> String {
    server_url.trim_end_matches('/').to_string()
}

fn cached_token(server_url: &str) -> Option<String> {
    let guard = TOKEN_CACHE.lock().ok()?;
    guard.as_ref()?.get(&cache_key(server_url)).cloned()
}

fn cache_token(server_url: &str, token: &str) {
    if let Ok(mut guard) = TOKEN_CACHE.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(cache_key(server_url), token.to_string());
    }
}

fn uncache_token(server_url: &str) {
    if let Ok(mut guard) = TOKEN_CACHE.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(&cache_key(server_url));
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RailsError {
    /// Machine-readable so the renderer can branch (e.g. show a
    /// "Reconnect" CTA on `rails_auth_expired`).
    pub code: String,
    pub message: String,
}

impl RailsError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl From<reqwest::Error> for RailsError {
    fn from(err: reqwest::Error) -> Self {
        RailsError::new("rails_unreachable", format!("network error: {err}"))
    }
}

fn build_client(timeout_secs: u64) -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("gaiare-animation-studio/0.1")
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .expect("reqwest client init")
}

fn client() -> reqwest::Client {
    build_client(15)
}

fn keychain_entry(server_url: &str) -> Result<Entry, RailsError> {
    // Normalise the account key so a stray trailing slash can't split the
    // same server into two keychain entries (connect under one, look up
    // under the other).
    let account = server_url.trim_end_matches('/');
    Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|e| RailsError::new("keychain_error", format!("keychain: {e}")))
}

/// Only talk to https hosts, or http on localhost (dev). Stops a stray /
/// malicious server URL from receiving the bearer token over plaintext.
fn validate_server(raw: &str) -> Result<(), RailsError> {
    let parsed =
        Url::parse(raw).map_err(|_| RailsError::new("bad_server", "Invalid server URL"))?;
    // Reject embedded credentials — `http://localhost@evil.com` style URLs
    // muddy which host actually receives the token.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(RailsError::new(
            "bad_server",
            "Server URL must not contain credentials",
        ));
    }
    let host = parsed.host_str().unwrap_or("");
    let is_localhost = host == "localhost" || host == "127.0.0.1" || host == "::1";
    let ok = parsed.scheme() == "https" || (parsed.scheme() == "http" && is_localhost);
    if ok {
        Ok(())
    } else {
        Err(RailsError::new(
            "bad_server",
            "Server must be https (or http on localhost)",
        ))
    }
}

fn token_for(server_url: &str) -> Result<String, RailsError> {
    if let Some(token) = cached_token(server_url) {
        return Ok(token);
    }
    let token = keychain_entry(server_url)?.get_password().map_err(|_| {
        RailsError::new("rails_not_connected", "Not connected to Rails — connect in Settings")
    })?;
    cache_token(server_url, &token);
    Ok(token)
}

fn endpoint(server_url: &str, path: &str) -> String {
    format!("{}/{}", server_url.trim_end_matches('/'), path)
}

fn map_status(status: reqwest::StatusCode) -> &'static str {
    match status.as_u16() {
        401 => "rails_auth_expired",
        403 => "rails_forbidden",
        404 => "rails_not_found",
        s if s >= 500 => "rails_server_error",
        _ => "rails_error",
    }
}

async fn api_get(server_url: &str, path: &str, query: Option<&Value>) -> Result<Value, RailsError> {
    validate_server(server_url)?;
    let token = token_for(server_url)?;

    let mut req = client()
        .get(endpoint(server_url, path))
        .header("Authorization", format!("Bearer {token}"));

    if let Some(Value::Object(map)) = query {
        let params: Vec<(String, String)> = map
            .iter()
            .filter_map(|(k, v)| {
                let s = match v {
                    Value::String(s) => s.clone(),
                    Value::Bool(b) => b.to_string(),
                    Value::Number(n) => n.to_string(),
                    _ => return None,
                };
                if s.is_empty() { None } else { Some((k.clone(), s)) }
            })
            .collect();
        req = req.query(&params);
    }

    let res = req.send().await?;
    let status = res.status();
    if status.is_success() {
        return Ok(res.json::<Value>().await?);
    }
    let body = res.text().await.unwrap_or_default();
    Err(RailsError::new(
        map_status(status),
        format!("Rails {status}: {}", body.chars().take(300).collect::<String>()),
    ))
}

/// Validate a freshly-pasted token against the server, then store it in
/// the keychain. Returns the countries payload (so JS can confirm the
/// connection is live). Never persists the token if validation fails.
#[tauri::command]
pub async fn rails_connect(server_url: String, token: String) -> Result<Value, RailsError> {
    validate_server(&server_url)?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(RailsError::new("bad_token", "Token is empty"));
    }

    let res = client()
        .get(endpoint(&server_url, "api/v1/studio/countries"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await?;
    let status = res.status();
    if !status.is_success() {
        return Err(RailsError::new(
            map_status(status),
            match status.as_u16() {
                401 => "Token rejected (401) — generate a fresh one in /admin".to_string(),
                403 => "Token is valid but not an admin (403)".to_string(),
                _ => format!("Rails {status}"),
            },
        ));
    }
    let body = res.json::<Value>().await?;

    keychain_entry(&server_url)?
        .set_password(&token)
        .map_err(|e| RailsError::new("keychain_error", format!("keychain: {e}")))?;
    // Seed the in-memory cache so subsequent requests this session don't
    // re-read the keychain (and re-prompt on unsigned dev builds).
    cache_token(&server_url, &token);

    Ok(body)
}

#[tauri::command]
pub fn rails_disconnect(server_url: String) -> Result<(), RailsError> {
    uncache_token(&server_url);
    match keychain_entry(&server_url)?.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(RailsError::new("keychain_error", format!("keychain: {e}"))),
    }
}

#[tauri::command]
pub fn rails_is_connected(server_url: String) -> bool {
    if cached_token(&server_url).is_some() {
        return true;
    }
    // One keychain read (caches it) — keeps later API calls prompt-free.
    match keychain_entry(&server_url)
        .ok()
        .and_then(|e| e.get_password().ok())
    {
        Some(token) => {
            cache_token(&server_url, &token);
            true
        }
        None => false,
    }
}

#[tauri::command]
pub async fn rails_list_questions(server_url: String, query: Value) -> Result<Value, RailsError> {
    api_get(&server_url, "api/v1/studio/questions", Some(&query)).await
}

#[tauri::command]
pub async fn rails_get_question(server_url: String, id: String) -> Result<Value, RailsError> {
    // `id` may be a "<country>/<external_ref>" composite — the slash is a
    // path separator the Rails glob route (questions/*id) expects.
    let path = format!("api/v1/studio/questions/{id}");
    api_get(&server_url, &path, None).await
}

#[tauri::command]
pub async fn rails_list_countries(server_url: String) -> Result<Value, RailsError> {
    api_get(&server_url, "api/v1/studio/countries", None).await
}

#[tauri::command]
pub async fn rails_list_submissions(
    server_url: String,
    question_id: String,
) -> Result<Value, RailsError> {
    let path = format!("api/v1/studio/questions/{question_id}/submissions");
    api_get(&server_url, &path, None).await
}

/// Mirror the Rails endpoint's 20 MB cap so we fail before slurping a huge
/// file into memory.
const MAX_SUBMIT_BYTES: u64 = 20 * 1024 * 1024;

/// `(content_type, expected_extension)` for a submission kind — one place
/// so the MIME we declare and the file we accept can't drift apart.
fn kind_format(kind: &str) -> Option<(&'static str, &'static str)> {
    match kind {
        "enhanced_image" => Some(("image/png", "png")),
        "video" => Some(("video/mp4", "mp4")),
        _ => None,
    }
}

/// Upload a studio-produced artwork (image / video) as a `proposed`
/// submission for a question. Multipart POST with the bearer token kept
/// server-side. `question_id` is the Rails DB id (the submissions route is
/// non-glob). `file_path` must resolve inside the user's Documents folder.
#[tauri::command]
pub async fn rails_submit_artifact(
    server_url: String,
    question_id: String,
    kind: String,
    file_path: String,
    note: Option<String>,
) -> Result<Value, RailsError> {
    validate_server(&server_url)?;
    let token = token_for(&server_url)?;

    let (content_type, expected_ext) = kind_format(&kind)
        .ok_or_else(|| RailsError::new("bad_kind", "kind must be enhanced_image or video"))?;

    // Refuse paths outside Documents (same guard as replicate_upload_file)
    // so a renderer bug can't exfiltrate an arbitrary file.
    let canon = assert_safe_document_path(Path::new(&file_path))
        .map_err(|e| RailsError::new("bad_path", e.message))?;

    // The declared content-type comes from `kind`, so the actual file must
    // match — otherwise we'd send e.g. webp bytes labelled image/png.
    let ext = canon
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != expected_ext {
        return Err(RailsError::new(
            "unsupported_file",
            format!("{kind} must be a .{expected_ext} file (got .{ext})"),
        ));
    }

    let meta = fs::metadata(&canon).await.map_err(|e| {
        RailsError::new("file_read_error", format!("stat failed for {}: {e}", canon.display()))
    })?;
    if meta.len() > MAX_SUBMIT_BYTES {
        return Err(RailsError::new(
            "too_large",
            format!("file too large: {} bytes (limit {MAX_SUBMIT_BYTES})", meta.len()),
        ));
    }

    let bytes = fs::read(&canon).await.map_err(|e| {
        RailsError::new("file_read_error", format!("failed to read {}: {e}", canon.display()))
    })?;
    let filename = canon
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("upload")
        .to_string();

    let part = multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str(content_type)
        .map_err(|e| RailsError::new("bad_mime", format!("invalid content type: {e}")))?;
    let mut form = multipart::Form::new().text("kind", kind).part("file", part);
    if let Some(note) = note {
        let note = note.trim().to_string();
        if !note.is_empty() {
            form = form.text("note", note);
        }
    }

    let path = format!("api/v1/studio/questions/{question_id}/submissions");
    // Generous timeout — a video upload over a slow link far outlasts the
    // 15s API-read default.
    let res = build_client(300)
        .post(endpoint(&server_url, &path))
        .header("Authorization", format!("Bearer {token}"))
        .multipart(form)
        .send()
        .await?;
    let status = res.status();
    if status.is_success() {
        return Ok(res.json::<Value>().await?);
    }
    let body = res.text().await.unwrap_or_default();
    Err(RailsError::new(
        map_status(status),
        format!("Rails {status}: {}", body.chars().take(300).collect::<String>()),
    ))
}
