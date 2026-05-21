//! Replicate proxy commands.
//!
//! Hosts the `REPLICATE_API_TOKEN` server-side so the renderer never
//! sees it (running `strings dist/*.js` on the bundled output would
//! otherwise reveal the token).
//!
//! Commands are deliberately thin pass-throughs — the renderer still
//! owns the poll loop, status callbacks, and abort logic. We just
//! relay the HTTPS call so the token stays in this process.

use std::path::Path;

use reqwest::multipart;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::fs;
use url::Url;

use crate::safe_path::assert_safe_document_path;

const REPLICATE_HOST: &str = "api.replicate.com";
const REPLICATE_BASE: &str = "https://api.replicate.com/v1";

/// Best-effort content-type guess from file extension. Replicate's
/// Files API accepts the bytes regardless of declared type, but a
/// correct hint helps Wan / other downstream models route the file.
fn guess_content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase()) {
        Some(ref ext) if ext == "jpg" || ext == "jpeg" => "image/jpeg",
        Some(ref ext) if ext == "png" => "image/png",
        Some(ref ext) if ext == "webp" => "image/webp",
        Some(ref ext) if ext == "mp4" => "video/mp4",
        Some(ref ext) if ext == "mov" => "video/quicktime",
        Some(ref ext) if ext == "mp3" => "audio/mpeg",
        Some(ref ext) if ext == "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

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
const ALLOWED_MODELS: &[&str] = &[
    "wan-video/wan-2.2-i2v-fast",
    "black-forest-labs/flux-kontext-pro",
];

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

/// A Replicate version hash is exactly 64 hex characters. Validating the
/// shape (rather than allowlisting specific hashes) lets the renderer pin
/// model versions in TypeScript — model upgrades stay a TS change — while
/// still stopping a compromised renderer from smuggling an arbitrary path
/// or URL through the `version` field.
fn is_valid_version_hash(v: &str) -> bool {
    v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Create a prediction pinned to a specific model VERSION hash. The
/// image-enhance models (SeedVR2, Clarity) are pinned by version for
/// reproducibility across the content pipeline; the renderer holds the
/// hashes and this command POSTs `{version, input}` to `/v1/predictions`.
#[tauri::command]
pub async fn replicate_create_prediction_by_version(
    version: String,
    input: Value,
) -> Result<Value, ReplicateError> {
    if !is_valid_version_hash(&version) {
        return Err(ReplicateError {
            message: "invalid Replicate version hash (expected 64 hex chars)".into(),
        });
    }
    let body = serde_json::json!({ "version": version, "input": input });
    request_json(
        reqwest::Method::POST,
        &format!("{REPLICATE_BASE}/predictions"),
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

/// Upload a local file to Replicate's Files API and return the
/// canonical URL to use as a prediction input.
///
/// Why: Wan (and most Replicate models) accept `input.image` as an
/// HTTPS URL — they fetch the bytes themselves. The original source
/// image of a workspace has an external CDN URL the user pasted in,
/// but ffmpeg-derived assets (extracted frames, trimmed clips, stitched
/// videos) only live in the user's Documents folder and have no
/// reachable URL. Posting them through this endpoint produces a
/// short-lived hosted URL that's good enough for the prediction to
/// fetch from.
///
/// Files expire after ~24 hours per Replicate's defaults — the caller
/// is expected to upload fresh on each generate rather than cache the
/// URL across days. For small images / short clips the upload cost
/// is sub-second.
#[derive(Debug, Serialize, Deserialize)]
pub struct UploadedFile {
    /// Canonical URL Replicate uses to refer to the file. Pass this as
    /// `input.image` (or similar) when starting a prediction; Replicate
    /// resolves it internally without re-billing the upload.
    pub url: String,
}

/// Replicate's Files API rejects uploads over 100 MB. We refuse a bit
/// earlier so the user gets a clear error before we slurp ~100 MB into
/// memory.
const MAX_UPLOAD_BYTES: u64 = 90 * 1024 * 1024;

#[tauri::command]
pub async fn replicate_upload_file(abs_path: String) -> Result<UploadedFile, ReplicateError> {
    let tok = token()?;

    // Refuse anything outside the user's Documents folder. Without this
    // a future renderer bug (or compromised tab component) could pass
    // an arbitrary path — e.g. `~/.ssh/id_rsa` — and Replicate would
    // happily host it on its public-ish file CDN. The canonicalised
    // path is what we use downstream so we don't act on the bypassable
    // original string.
    let canon = assert_safe_document_path(Path::new(&abs_path)).map_err(|e| ReplicateError {
        message: e.message,
    })?;

    let filename = canon
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("upload.bin")
        .to_string();
    let content_type = guess_content_type(&canon);

    // Size cap BEFORE the in-memory read so a 4 GB stitched video
    // doesn't OOM the sidecar. tokio::fs::read loads the entire
    // file into a Vec<u8>, and reqwest's multipart::Part::bytes
    // takes ownership of another copy. A 90 MB cap leaves headroom
    // under Replicate's 100 MB API limit and stays well under the
    // memory we're comfortable spiking in this process.
    let metadata = fs::metadata(&canon).await.map_err(|e| ReplicateError {
        message: format!("stat failed for {}: {e}", canon.display()),
    })?;
    if metadata.len() > MAX_UPLOAD_BYTES {
        return Err(ReplicateError {
            message: format!(
                "file too large to upload to Replicate: {} bytes (limit {})",
                metadata.len(),
                MAX_UPLOAD_BYTES
            ),
        });
    }

    let bytes = fs::read(&canon).await.map_err(|e| ReplicateError {
        message: format!("failed to read {}: {e}", canon.display()),
    })?;

    let part = multipart::Part::bytes(bytes)
        .file_name(filename.clone())
        .mime_str(content_type)
        .map_err(|e| ReplicateError {
            message: format!("invalid content type {content_type}: {e}"),
        })?;
    let form = multipart::Form::new().part("content", part);

    let res = client()
        .post(format!("{REPLICATE_BASE}/files"))
        .header("Authorization", format!("Token {tok}"))
        .multipart(form)
        .send()
        .await?;
    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_else(|_| "<no body>".into());
        return Err(ReplicateError {
            message: format!("Replicate Files API {status}: {text}"),
        });
    }
    let body: Value = res.json().await?;
    // Replicate's response: { id, name, urls: { get, download }, ... }
    // `get` is the canonical resource URL; predictions resolve it
    // server-side. Prefer it over `download` to keep things explicit.
    let url = body
        .get("urls")
        .and_then(|u| u.get("get"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| ReplicateError {
            message: format!("Replicate Files API response missing urls.get: {body}"),
        })?
        .to_string();
    Ok(UploadedFile { url })
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
