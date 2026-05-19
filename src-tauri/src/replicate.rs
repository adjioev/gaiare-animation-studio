//! Replicate proxy commands.
//!
//! Hosts the `REPLICATE_API_TOKEN` server-side so the renderer never
//! sees it (running `strings dist/*.js` on the bundled output would
//! otherwise reveal the token).
//!
//! Commands are deliberately thin pass-throughs — the renderer still
//! owns the poll loop, status callbacks, and abort logic. We just
//! relay the HTTPS call so the token stays in this process.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

const REPLICATE_HOST: &str = "api.replicate.com";
const REPLICATE_BASE: &str = "https://api.replicate.com/v1";

/// Strict authority check — `starts_with("https://api.replicate.com/")`
/// would let `https://api.replicate.com.attacker.com/...` through and
/// leak the token to a malicious host. Parse the URL and compare the
/// host segment exactly.
fn is_replicate_url(raw: &str) -> bool {
    match Url::parse(raw) {
        Ok(parsed) => {
            parsed.scheme() == "https" && parsed.host_str() == Some(REPLICATE_HOST)
        }
        Err(_) => false,
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReplicateError {
    pub message: String,
}

impl From<reqwest::Error> for ReplicateError {
    fn from(err: reqwest::Error) -> Self {
        Self {
            message: format!("network error: {err}"),
        }
    }
}

impl From<std::env::VarError> for ReplicateError {
    fn from(err: std::env::VarError) -> Self {
        Self {
            message: format!(
                "REPLICATE_API_TOKEN missing from env ({err}). \
                 Set it in the .env file the Rust process reads on startup."
            ),
        }
    }
}

fn token() -> Result<String, ReplicateError> {
    Ok(std::env::var("REPLICATE_API_TOKEN")?)
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("gaiare-animation-studio/0.1")
        .build()
        .expect("reqwest client init")
}

async fn request_json(
    method: reqwest::Method,
    url: &str,
    body: Option<Value>,
) -> Result<Value, ReplicateError> {
    let tok = token()?;
    let mut req = client()
        .request(method, url)
        .header("Authorization", format!("Token {tok}"))
        .header("Content-Type", "application/json");
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await?;
    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_else(|_| "<no body>".into());
        return Err(ReplicateError {
            message: format!("Replicate {status}: {text}"),
        });
    }
    let json: Value = res.json().await?;
    Ok(json)
}

/// Models the renderer is allowed to invoke through this proxy. The
/// allowlist prevents a compromised / malicious renderer from billing
/// arbitrary expensive models against the team's Replicate token —
/// adding a new model requires a Rust rebuild, which is the right
/// gate for a security-sensitive choice.
///
/// Format: `owner/name`. Versioned slugs (`owner/name:hash`) are
/// allowed but should be the exception — pinning a version freezes
/// behaviour but blocks bug-fix updates.
const ALLOWED_MODELS: &[&str] = &["wan-video/wan-2.2-i2v-fast"];

/// Start a prediction on any allowlisted Replicate model. The
/// renderer chooses the model + input parameters; Rust validates the
/// model is on the allowlist and forwards the request with the token.
///
/// Why this is configurable from JS: Replicate retires model
/// deployments on its own schedule (Wan 2.2 → 2.3 → 2.5 …). If the
/// renderer can swap model strings, model upgrades become a one-line
/// TypeScript change rather than a Rust rebuild + redistribute.
#[tauri::command]
pub async fn replicate_create_prediction(
    model: String,
    input: Value,
) -> Result<Value, ReplicateError> {
    if !ALLOWED_MODELS.contains(&model.as_str()) {
        return Err(ReplicateError {
            message: format!(
                "model '{model}' not in proxy allowlist — add it to ALLOWED_MODELS in replicate.rs"
            ),
        });
    }
    let body = serde_json::json!({ "input": input });
    request_json(
        reqwest::Method::POST,
        &format!("{REPLICATE_BASE}/models/{model}/predictions"),
        Some(body),
    )
    .await
}

/// Fetch the current state of a prediction. The renderer drives the
/// poll loop and decides when to stop.
#[tauri::command]
pub async fn replicate_get_prediction(url: String) -> Result<Value, ReplicateError> {
    if !is_replicate_url(&url) {
        // Don't echo the rejected URL — a stray pre-signed S3 link
        // forwarded here by mistake would otherwise be round-tripped
        // back into the renderer's error banner.
        eprintln!("[replicate] rejected non-Replicate URL: {url}");
        return Err(ReplicateError {
            message: "refusing to proxy non-Replicate URL".into(),
        });
    }
    request_json(reqwest::Method::GET, &url, None).await
}

/// POST a cancel URL — best-effort, so even a 4xx is logged but not
/// propagated. Replicate stops billing the prediction once cancelled.
#[tauri::command]
pub async fn replicate_cancel_prediction(url: String) -> Result<(), ReplicateError> {
    if !is_replicate_url(&url) {
        eprintln!("[replicate] rejected non-Replicate cancel URL: {url}");
        return Err(ReplicateError {
            message: "refusing to proxy non-Replicate URL".into(),
        });
    }
    // Swallow downstream errors (network, 4xx) — cancellation is
    // best-effort and we already gave up on the result. The URL
    // guard above is still propagated.
    let _ = request_json(reqwest::Method::POST, &url, None).await;
    Ok(())
}
