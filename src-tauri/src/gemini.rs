//! Gemini image-generation proxy.
//!
//! Holds `GOOGLE_GENERATIVE_AI_API_KEY` server-side so the renderer's JS
//! bundle never sees it. Mirrors the Rails `GeminiImageService` request
//! shape exactly (parts = [instruction, ...inlineData images, "---" +
//! prompt], `responseModalities: [TEXT, IMAGE]`, `imageConfig.aspectRatio`)
//! — that shape is already proven for sign rendering in the tutorial
//! illustrator.
//!
//! The command is image-agnostic: it relays base64 `inlineData` and knows
//! nothing about signs / crops. The renderer assembles the image list
//! (source first, references after) and the instruction text.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const GEMINI_BASE: &str = "https://generativelanguage.googleapis.com/v1beta/models";

/// Default image model — flash variant: cheaper, good enough for the
/// localised sign repaint. Reconfigurable per-call within the allowlist.
const DEFAULT_MODEL: &str = "gemini-2.5-flash-image";

/// Models the renderer may invoke. Same defence shape as the Replicate /
/// Fireworks allowlists — a compromised renderer can't bill an arbitrary
/// model against the team's Google key. Adding one is a Rust rebuild.
const ALLOWED_MODELS: &[&str] = &["gemini-2.5-flash-image", "gemini-3-pro-image-preview"];

#[derive(Debug, Deserialize)]
pub struct InlineImage {
    pub mime_type: String,
    /// Base64-encoded image bytes (no data: prefix).
    pub data: String,
}

#[derive(Debug, Serialize)]
pub struct GeneratedImage {
    pub mime_type: String,
    /// Base64-encoded image bytes (no data: prefix).
    pub data: String,
}

/// Rasterise SVG markup to a crisp PNG at `size` px on the long edge.
/// resvg renders the vector at the target resolution (no upscaling blur),
/// unlike the browser-canvas path which first decodes the SVG at its
/// intrinsic size and then scales the bitmap up. JS fetches the bytes
/// (keeping the network call out of Rust) and passes the markup here.
#[tauri::command]
pub fn rasterize_svg(svg: String, size: Option<u32>) -> Result<GeneratedImage, GeminiError> {
    use base64::Engine;

    let target = size.unwrap_or(1024).clamp(16, 4096);

    let mut opt = resvg::usvg::Options::default();
    // Sign SVGs sometimes carry live <text> (e.g. numbers) — load system
    // fonts so it renders instead of dropping out.
    opt.fontdb_mut().load_system_fonts();

    let tree = resvg::usvg::Tree::from_str(&svg, &opt)
        .map_err(|e| GeminiError { message: format!("invalid SVG: {e}") })?;

    let svg_size = tree.size();
    let max_edge = svg_size.width().max(svg_size.height());
    if max_edge <= 0.0 {
        return Err(GeminiError { message: "SVG has zero size".into() });
    }
    let scale = target as f32 / max_edge;
    let pw = ((svg_size.width() * scale).round() as u32).max(1);
    let ph = ((svg_size.height() * scale).round() as u32).max(1);

    let mut pixmap = resvg::tiny_skia::Pixmap::new(pw, ph)
        .ok_or_else(|| GeminiError { message: "failed to allocate pixmap".into() })?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let png = pixmap
        .encode_png()
        .map_err(|e| GeminiError { message: format!("png encode failed: {e}") })?;

    Ok(GeneratedImage {
        mime_type: "image/png".into(),
        data: base64::engine::general_purpose::STANDARD.encode(png),
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GeminiError {
    pub message: String,
}

impl From<reqwest::Error> for GeminiError {
    fn from(err: reqwest::Error) -> Self {
        Self {
            message: format!("network error: {err}"),
        }
    }
}

fn api_key() -> Result<String, GeminiError> {
    std::env::var("GOOGLE_GENERATIVE_AI_API_KEY").map_err(|e| GeminiError {
        message: format!(
            "GOOGLE_GENERATIVE_AI_API_KEY missing from env ({e}). \
             Add it to the .env the Rust process reads on startup."
        ),
    })
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("gaiare-animation-studio/0.1")
        .build()
        .expect("reqwest client init")
}

/// Generate / edit an image with Gemini. `images` is an ordered list the
/// model conditions on (for sign-fix: the source photo first, then the
/// correct sign reference(s)). `instruction` is the fixed scaffold,
/// `prompt` is the user's free-text guidance appended after a separator.
#[tauri::command]
pub async fn gemini_generate_image(
    instruction: String,
    images: Vec<InlineImage>,
    prompt: String,
    aspect_ratio: String,
    model: Option<String>,
) -> Result<GeneratedImage, GeminiError> {
    let model = model.unwrap_or_else(|| DEFAULT_MODEL.to_string());
    if !ALLOWED_MODELS.contains(&model.as_str()) {
        return Err(GeminiError {
            message: format!(
                "model '{model}' not in proxy allowlist — add it to ALLOWED_MODELS in gemini.rs"
            ),
        });
    }
    let key = api_key()?;

    // Part ordering mirrors Rails `build_prompt_parts`: instruction →
    // reference images → separator + user prompt.
    let mut parts: Vec<Value> = Vec::new();
    if !instruction.trim().is_empty() {
        parts.push(json!({ "text": instruction }));
    }
    for img in &images {
        parts.push(json!({
            "inlineData": { "mimeType": img.mime_type, "data": img.data }
        }));
    }
    parts.push(json!({ "text": format!("\n---\n\n{prompt}") }));

    let body = json!({
        "contents": [{ "parts": parts }],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": { "aspectRatio": aspect_ratio }
        }
    });

    let url = format!("{GEMINI_BASE}/{model}:generateContent");
    let res = client()
        .post(&url)
        .header("x-goog-api-key", key.as_str())
        .json(&body)
        .send()
        .await?;

    let status = res.status();
    if !status.is_success() {
        // Body may echo request detail but never the key (it's sent as a
        // header we don't log). Truncate to keep the renderer banner sane.
        let text = res.text().await.unwrap_or_else(|_| "<no body>".into());
        let excerpt: String = text.chars().take(500).collect();
        return Err(GeminiError {
            message: format!("Gemini {status}: {excerpt}"),
        });
    }

    let json: Value = res.json().await?;
    let image_part = json
        .pointer("/candidates/0/content/parts")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.iter().find(|p| p.get("inlineData").is_some()));

    let inline = image_part.and_then(|p| p.get("inlineData")).ok_or_else(|| {
        // No image in the response usually means the model replied with
        // text only (refusal / safety). Surface a short reason if present.
        let text_part = json
            .pointer("/candidates/0/content/parts")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.iter().find_map(|p| p.get("text").and_then(|t| t.as_str())))
            .unwrap_or("");
        GeminiError {
            message: if text_part.is_empty() {
                "Gemini returned no image".into()
            } else {
                format!("Gemini returned no image: {}", &text_part.chars().take(300).collect::<String>())
            },
        }
    })?;

    let mime_type = inline
        .get("mimeType")
        .and_then(|v| v.as_str())
        .unwrap_or("image/png")
        .to_string();
    let data = inline
        .get("data")
        .and_then(|v| v.as_str())
        .ok_or_else(|| GeminiError {
            message: "Gemini inlineData missing data field".into(),
        })?
        .to_string();

    Ok(GeneratedImage { mime_type, data })
}
