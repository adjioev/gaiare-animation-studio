//! Rails Studio API proxy.
//!
//! The bearer token lives in the OS keychain (macOS Keychain), never in
//! the JS bundle. JS hands the token to `rails_connect` exactly once (on
//! paste); after that the proxy commands read it from the keychain when
//! making requests. Mirrors the replicate.rs / llm.rs threat model: the
//! secret stays in this process.

use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

const KEYCHAIN_SERVICE: &str = "gaiare-animation-studio.rails-token";

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

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("gaiare-animation-studio/0.1")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("reqwest client init")
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
    keychain_entry(server_url)?
        .get_password()
        .map_err(|_| RailsError::new("rails_not_connected", "Not connected to Rails — connect in Settings"))
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

    Ok(body)
}

#[tauri::command]
pub fn rails_disconnect(server_url: String) -> Result<(), RailsError> {
    match keychain_entry(&server_url)?.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(RailsError::new("keychain_error", format!("keychain: {e}"))),
    }
}

#[tauri::command]
pub fn rails_is_connected(server_url: String) -> bool {
    keychain_entry(&server_url)
        .ok()
        .and_then(|e| e.get_password().ok())
        .is_some()
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
