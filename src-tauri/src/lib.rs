// Tauri runtime. Plugins surface filesystem, shell (ffmpeg subprocess),
// HTTP (asset downloads from public CDNs), dialog (file pickers).
//
// Most renderer logic stays in TypeScript; Rust hosts the Replicate
// proxy commands so the API token never enters the JS bundle.

mod gemini;
mod llm;
mod rails;
mod replicate;
mod safe_path;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use gemini::{gemini_generate_image, rasterize_svg};
use llm::fireworks_chat;
use rails::{
    rails_claim_job, rails_connect, rails_disconnect, rails_get_question, rails_is_connected,
    rails_list_countries, rails_list_jobs, rails_list_questions, rails_list_submissions,
    rails_release_job, rails_submit_artifact,
};
use replicate::{
    replicate_cancel_prediction, replicate_create_prediction,
    replicate_create_prediction_by_version, replicate_get_prediction, replicate_upload_file,
};
use safe_path::assert_safe_document_path_cmd;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Emitter;

/// `true` once the user has confirmed they want to quit via the JS
/// modal. The `ExitRequested` fallback in `app.run()` re-runs after
/// `force_quit` triggers `app.exit(0)`; this flag tells it to let the
/// exit proceed instead of intercepting again.
static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

/// `true` between "we asked JS to confirm" and "JS came back with an
/// answer" (either via `force_quit` or `cancel_quit`). Prevents
/// duplicate emits when both the menu Quit item AND the ExitRequested
/// fallback fire for the same user gesture, and stops spam-press of
/// Cmd+Q from opening multiple modals.
static QUIT_PENDING: AtomicBool = AtomicBool::new(false);

/// Unix-millis timestamp of the last `arm_quit` call. `force_quit`
/// refuses to exit unless this is within `ARM_WINDOW_MS`. The arming
/// step is invoked by the JS modal's `onConfirm`, so a future tab
/// component invoking `force_quit` directly (bug or compromised
/// renderer asset) can't bypass the confirm dialog.
static QUIT_ARMED_AT: AtomicI64 = AtomicI64::new(0);
const ARM_WINDOW_MS: i64 = 10_000;

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Records that the JS confirm modal accepted the quit. The pairing
/// with `force_quit` is one-shot: arming once allows a single force_quit
/// within the next 10 s, after which arming would need to happen again.
#[tauri::command]
fn arm_quit() {
    QUIT_ARMED_AT.store(now_millis(), Ordering::SeqCst);
}

/// JS calls this AFTER the user clicked Confirm on the quit modal and
/// AFTER `arm_quit`. Without the arm-within-window check, any code in
/// the renderer could bypass the modal by invoking force_quit directly.
#[tauri::command]
fn force_quit(app: tauri::AppHandle) -> Result<(), String> {
    let armed = QUIT_ARMED_AT.load(Ordering::SeqCst);
    let now = now_millis();
    if armed == 0 || now - armed > ARM_WINDOW_MS {
        eprintln!("[quit] force_quit refused — not armed within window");
        return Err("force_quit not armed; call arm_quit first".into());
    }
    QUIT_CONFIRMED.store(true, Ordering::SeqCst);
    // Burn the arm so a stale invocation can't be replayed.
    QUIT_ARMED_AT.store(0, Ordering::SeqCst);
    QUIT_PENDING.store(false, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

/// JS calls this when the user dismisses the confirm modal (Cancel /
/// Escape / backdrop). Releases the pending flag so the next quit
/// gesture isn't deduped.
#[tauri::command]
fn cancel_quit() {
    QUIT_PENDING.store(false, Ordering::SeqCst);
}

/// Emits `app-quit-requested` to the renderer, dedup'd by `QUIT_PENDING`.
/// Returns `true` if the emit happened, `false` if a previous request is
/// still in flight (the modal is already up).
fn try_emit_quit_request(app: &tauri::AppHandle) -> bool {
    // compare_exchange so we don't have a TOCTOU between read + store.
    if QUIT_PENDING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        eprintln!("[quit] already pending — skipping duplicate emit");
        return false;
    }
    if let Err(e) = app.emit("app-quit-requested", ()) {
        eprintln!("[quit] emit failed: {e} — quitting anyway");
        // Force exit on emit failure — if the webview is gone, the
        // user can't possibly confirm anyway.
        QUIT_CONFIRMED.store(true, Ordering::SeqCst);
        app.exit(0);
    }
    true
}

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

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Custom macOS app menu — on Mac, the system Cmd+Q goes
            // through the menu's "Quit" item via NSApp.terminate, NOT
            // through RunEvent::ExitRequested. Without overriding the
            // menu, our intercept never sees Cmd+Q.
            //
            // By giving the Quit item our own id and handling it in
            // on_menu_event we route Cmd+Q through the same flow as a
            // red-dot close: emit "app-quit-requested" → JS modal →
            // force_quit on confirm. We rebuild the standard macOS
            // app menu (About / Hide / Quit etc.) using Tauri's
            // PredefinedMenuItem helpers so users don't lose default
            // behaviour like Hide Others or Show All.
            #[cfg(target_os = "macos")]
            {
                let app_handle = app.handle();
                let about = PredefinedMenuItem::about(app_handle, Some("About Animation Studio"), None)?;
                let services = PredefinedMenuItem::services(app_handle, None)?;
                let hide = PredefinedMenuItem::hide(app_handle, None)?;
                let hide_others = PredefinedMenuItem::hide_others(app_handle, None)?;
                let show_all = PredefinedMenuItem::show_all(app_handle, None)?;
                let separator1 = PredefinedMenuItem::separator(app_handle)?;
                let separator2 = PredefinedMenuItem::separator(app_handle)?;
                let separator3 = PredefinedMenuItem::separator(app_handle)?;

                let quit = MenuItemBuilder::with_id("quit", "Quit Animation Studio")
                    .accelerator("Cmd+Q")
                    .build(app_handle)?;

                let app_menu = SubmenuBuilder::new(app_handle, "Animation Studio")
                    .item(&about)
                    .item(&separator1)
                    .item(&services)
                    .item(&separator2)
                    .item(&hide)
                    .item(&hide_others)
                    .item(&show_all)
                    .item(&separator3)
                    .item(&quit)
                    .build()?;

                // Edit menu — standard cut/copy/paste/select-all. The
                // text inputs in the app rely on these existing in the
                // menu bar; without an Edit menu, Cmd+C / Cmd+V in
                // <input>/<textarea> elements break on macOS.
                let edit_menu = SubmenuBuilder::new(app_handle, "Edit")
                    .item(&PredefinedMenuItem::undo(app_handle, None)?)
                    .item(&PredefinedMenuItem::redo(app_handle, None)?)
                    .item(&PredefinedMenuItem::separator(app_handle)?)
                    .item(&PredefinedMenuItem::cut(app_handle, None)?)
                    .item(&PredefinedMenuItem::copy(app_handle, None)?)
                    .item(&PredefinedMenuItem::paste(app_handle, None)?)
                    .item(&PredefinedMenuItem::select_all(app_handle, None)?)
                    .build()?;

                // Window submenu — restores ⌘M (minimize), zoom, and
                // full-screen toggle that macOS users expect. Without
                // it set_menu() leaves the app without a Window menu
                // entirely, so ⌘M is dead and the app can't appear in
                // other apps' Window menus.
                let window_menu = SubmenuBuilder::new(app_handle, "Window")
                    .item(&PredefinedMenuItem::minimize(app_handle, None)?)
                    .item(&PredefinedMenuItem::maximize(app_handle, None)?)
                    .item(&PredefinedMenuItem::separator(app_handle)?)
                    .item(&PredefinedMenuItem::fullscreen(app_handle, None)?)
                    .build()?;

                let menu = MenuBuilder::new(app_handle)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .item(&window_menu)
                    .build()?;
                app.set_menu(menu)?;
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "quit" {
                eprintln!("[quit] menu Cmd+Q intercepted — asking JS");
                try_emit_quit_request(app);
            }
        })
        .invoke_handler(tauri::generate_handler![
            replicate_create_prediction,
            replicate_create_prediction_by_version,
            replicate_get_prediction,
            replicate_cancel_prediction,
            replicate_upload_file,
            assert_safe_document_path_cmd,
            fireworks_chat,
            gemini_generate_image,
            rasterize_svg,
            rails_connect,
            rails_disconnect,
            rails_is_connected,
            rails_list_questions,
            rails_get_question,
            rails_list_countries,
            rails_list_submissions,
            rails_submit_artifact,
            rails_list_jobs,
            rails_claim_job,
            rails_release_job,
            arm_quit,
            force_quit,
            cancel_quit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Cmd+Q (macOS) routed via custom menu → on_menu_event handles
        // it. ExitRequested here is the fallback for OTHER paths into
        // app exit (red-dot close on a single-window app, dock Quit,
        // future programmatic exit). Both paths go through
        // try_emit_quit_request which dedup's so a single user gesture
        // produces a single modal.
        if let tauri::RunEvent::ExitRequested { api, .. } = &event {
            if QUIT_CONFIRMED.load(Ordering::SeqCst) {
                eprintln!("[quit] confirmed — exit proceeds");
            } else {
                eprintln!("[quit] ExitRequested fallback — asking JS");
                api.prevent_exit();
                try_emit_quit_request(app_handle);
            }
        }
    });
}
