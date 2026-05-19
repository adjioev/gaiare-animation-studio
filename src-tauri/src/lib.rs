// Tauri runtime. Plugins surface filesystem, shell (ffmpeg subprocess),
// HTTP (Replicate / ElevenLabs / next-server), dialog (file pickers).
// All actual logic lives in the React frontend for the MVP — Rust here
// is just the plugin bootstrap. Future iterations may move secrets out
// of the client bundle by adding `#[tauri::command]` proxies for the
// Replicate / ElevenLabs calls.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
