// Tauri runtime. Plugins surface filesystem, shell (ffmpeg subprocess),
// HTTP (asset downloads from public CDNs), dialog (file pickers).
//
// Most renderer logic stays in TypeScript; Rust hosts the Replicate
// proxy commands so the API token never enters the JS bundle.

mod replicate;

use std::path::PathBuf;

use replicate::{
    replicate_cancel_prediction, replicate_create_prediction, replicate_get_prediction,
};

/// Locate the project's `.env` across both dev and packaged builds.
///
/// In `pnpm tauri dev` the process cwd is the project root, so the
/// classic `dotenvy::dotenv()` walk-up finds `.env` immediately. In a
/// packaged macOS `.app` the cwd is typically `/` (Finder launch) or
/// the user's shell cwd — neither contains the project `.env` — and
/// without a fallback every Replicate command would fail at runtime
/// with a confusing "REPLICATE_API_TOKEN missing" message.
///
/// Fallback search order:
///   1. `dotenvy::dotenv()` — current dir + parent walk (dev path)
///   2. `<Documents>/gaiare-animation-studio/.env` — drop the file
///      next to the workspace folder so contractors can supply their
///      own token without rebuilding. The path is intentionally the
///      same root the workspace lives in so contractors don't have to
///      remember a second location.
///   3. `~/.gaiare/.env` — fallback for users who keep workspaces on
///      external drives.
///
/// Returns `true` if any of the sources populated `REPLICATE_API_TOKEN`,
/// `false` otherwise. Callers (the Replicate commands) surface a clear
/// "token missing — see README" error if the load failed.
fn load_env() -> bool {
    if dotenvy::dotenv().is_ok() {
        return std::env::var("REPLICATE_API_TOKEN").is_ok();
    }
    let candidates: Vec<PathBuf> = [
        dirs::document_dir().map(|d| d.join("gaiare-animation-studio").join(".env")),
        dirs::home_dir().map(|h| h.join(".gaiare").join(".env")),
    ]
    .into_iter()
    .flatten()
    .collect();
    for path in candidates {
        if path.exists() {
            if dotenvy::from_path(&path).is_ok() {
                eprintln!("[env] loaded {}", path.display());
                return std::env::var("REPLICATE_API_TOKEN").is_ok();
            }
        }
    }
    eprintln!(
        "[env] no .env found in cwd, Documents/gaiare-animation-studio, or ~/.gaiare — \
         Replicate commands will fail until REPLICATE_API_TOKEN is set"
    );
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = load_env();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            replicate_create_prediction,
            replicate_get_prediction,
            replicate_cancel_prediction,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
