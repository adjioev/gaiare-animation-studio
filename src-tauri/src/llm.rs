//! LLM proxy commands.
//!
//! Holds the Fireworks API token server-side so the renderer's JS bundle
//! never sees it. Fireworks exposes an OpenAI-compatible Chat Completions
//! endpoint, so this is essentially a thin POST wrapper plus an
//! allowlist of model slugs.
//!
//! Why Fireworks + Kimi K2.5 specifically: Claude/GPT are 3–5× more
//! expensive per token for the kind of long-context iterative prompt
//! refinement this chat does. Kimi K2.5 instruction-follows well enough
//! for "rewrite this Wan prompt with X change" without the Anthropic
//! tax. We keep this configurable per-call so the renderer can swap
//! models without a Rust rebuild.

use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const FIREWORKS_BASE: &str = "https://api.fireworks.ai/inference/v1";

/// Models the renderer can invoke through this proxy. Same defence
/// shape as the Replicate allowlist — a compromised tab can't bill
/// arbitrary expensive models against our Fireworks token.
/// The single Fireworks slug the renderer is allowed to invoke. Kimi
/// K2.6 covers both text and vision (`supports_image_input: true`),
/// so we don't maintain a list — when this needs to change it's a
/// one-line Rust rebuild, which is the right gate for a billing-
/// sensitive choice.
const ALLOWED_MODEL: &str = "accounts/fireworks/models/kimi-k2p6";

#[derive(Debug, Serialize, Deserialize)]
pub struct LlmError {
    pub message: String,
}

impl From<reqwest::Error> for LlmError {
    fn from(err: reqwest::Error) -> Self {
        Self {
            message: format!("network error: {err}"),
        }
    }
}

impl From<std::env::VarError> for LlmError {
    fn from(err: std::env::VarError) -> Self {
        Self {
            message: format!(
                "FIREWORKS_API_KEY missing from env ({err}). \
                 Set it in the .env file the Rust process reads on startup."
            ),
        }
    }
}

fn token() -> Result<String, LlmError> {
    Ok(std::env::var("FIREWORKS_API_KEY")?)
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("gaiare-animation-studio/0.1")
        .build()
        .expect("reqwest client init")
}

/// Chat completion request. Messages are opaque `Value`s so the
/// renderer can ship either text-only (`content: "..."`) or multipart
/// (`content: [{type:"text",...},{type:"image_url",...}]`) shapes
/// without us needing a Rust schema for every OpenAI vision variant.
/// Fireworks rejects malformed payloads — we forward then surface their
/// error.
#[derive(Debug, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatResponse {
    /// Assistant text the model returned. Concatenation of message
    /// `content` strings — the renderer treats it as opaque markdown.
    pub text: String,
    /// Token counts so the renderer can render a cumulative cost meter.
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    /// Why generation stopped. `"stop"` is a clean finish, `"length"`
    /// means `max_tokens` hit — output is truncated and the UI should
    /// warn the user. Other values (`"content_filter"`, model-specific)
    /// surface as-is.
    pub finish_reason: String,
}

/// Send a chat completion to Fireworks. The renderer assembles the
/// full message history (system + user + assistant turns) and ships it
/// every call — Fireworks is stateless, so we don't try to maintain
/// per-session memory server-side.
#[tauri::command]
pub async fn fireworks_chat(req: ChatRequest) -> Result<ChatResponse, LlmError> {
    if req.model != ALLOWED_MODEL {
        return Err(LlmError {
            message: format!(
                "model '{}' not allowed — only '{ALLOWED_MODEL}' is accepted by this proxy. \
                 Edit ALLOWED_MODEL in llm.rs to change it.",
                req.model
            ),
        });
    }

    let tok = token()?;
    let mut headers = HeaderMap::new();
    headers.insert(
        "Authorization",
        format!("Bearer {tok}").parse().map_err(|e| LlmError {
            message: format!("invalid token header: {e}"),
        })?,
    );

    let body = json!({
        "model": req.model,
        "messages": req.messages,
        "max_tokens": req.max_tokens.unwrap_or(2048),
        "temperature": req.temperature.unwrap_or(0.7),
    });

    let res = client()
        .post(format!("{FIREWORKS_BASE}/chat/completions"))
        .headers(headers)
        .json(&body)
        .send()
        .await?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_else(|_| "<no body>".into());
        return Err(LlmError {
            message: format!("Fireworks {status}: {text}"),
        });
    }

    let json: Value = res.json().await?;
    let text = json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| LlmError {
            message: format!("Fireworks response missing choices[0].message.content: {json}"),
        })?
        .to_string();

    let usage = json.get("usage");
    let prompt_tokens = usage
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let completion_tokens = usage
        .and_then(|u| u.get("completion_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    let finish_reason = json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("finish_reason"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    Ok(ChatResponse {
        text,
        prompt_tokens,
        completion_tokens,
        finish_reason,
    })
}
