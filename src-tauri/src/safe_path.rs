//! Path-safety helper shared between the Replicate proxy and the
//! ffmpeg wrappers.
//!
//! The earlier TS-only `assertSafeDocumentPath` did a naïve
//! `startsWith(documentsDir)` on a non-canonicalised string. That
//! check is bypassable two ways: a filename of `"../../../etc/passwd"`
//! produces an absolute path that still *string*-starts with the
//! Documents root (Tauri's `path.join` doesn't resolve `..`), and a
//! sibling dir named e.g. `DocumentsEvil` prefixes `Documents`. Both
//! are theoretical-only with a trusted renderer, but the explicit
//! goal of the guard was defence against a future bug / compromised
//! tab component, so the guard should actually hold.
//!
//! This Rust-side check uses `std::fs::canonicalize` which resolves
//! `..`, symlinks, and case-normalises on case-insensitive volumes,
//! then compares against a canonicalised Documents root with a
//! trailing separator. A path that doesn't pass leaves with an error;
//! it never reaches `Command::sidecar` or the Replicate Files API.

use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct SafePathError {
    pub message: String,
}

impl SafePathError {
    fn new(msg: impl Into<String>) -> Self {
        Self {
            message: msg.into(),
        }
    }
}

fn documents_root() -> Result<PathBuf, SafePathError> {
    let raw = dirs::document_dir().ok_or_else(|| {
        SafePathError::new("Documents directory not resolvable on this system")
    })?;
    std::fs::canonicalize(&raw).map_err(|e| {
        SafePathError::new(format!(
            "canonicalize Documents root failed ({}): {e}",
            raw.display()
        ))
    })
}

/// Canonicalises `path` and asserts it lives under the user's Documents
/// directory. Returns the canonicalised path on success — callers use
/// this normalised form, so a subsequent `Command::sidecar` argument
/// has no `..` segments to surprise ffmpeg.
///
/// Handles output paths (file not yet on disk): `std::fs::canonicalize`
/// requires the path to exist, so if it doesn't we canonicalise the
/// parent directory (which must exist — callers always run
/// `ensureWorkdir` before invoking ffmpeg) and re-attach the filename.
pub fn assert_safe_document_path(path: &Path) -> Result<PathBuf, SafePathError> {
    let canon = if path.exists() {
        std::fs::canonicalize(path).map_err(|e| {
            SafePathError::new(format!(
                "canonicalize failed for {}: {e}",
                path.display()
            ))
        })?
    } else {
        let parent = path.parent().ok_or_else(|| {
            SafePathError::new(format!("no parent for {}", path.display()))
        })?;
        let filename = path.file_name().ok_or_else(|| {
            SafePathError::new(format!("no filename in {}", path.display()))
        })?;
        let canon_parent = std::fs::canonicalize(parent).map_err(|e| {
            SafePathError::new(format!(
                "canonicalize parent failed for {}: {e}",
                parent.display()
            ))
        })?;
        canon_parent.join(filename)
    };

    let root = documents_root()?;
    // `Path::starts_with` matches whole path components, not a string
    // prefix — so `/foo/DocumentsEvil` does NOT start_with `/foo/Documents`.
    // Exactly the bug the trailing-separator hack worked around.
    if !canon.starts_with(&root) {
        return Err(SafePathError::new(format!(
            "refusing path outside Documents: {} (root: {})",
            canon.display(),
            root.display()
        )));
    }
    Ok(canon)
}

/// Tauri command surface — TS wrappers invoke this so they don't have
/// to reimplement the canonicalisation rules.
#[tauri::command]
pub fn assert_safe_document_path_cmd(abs_path: String) -> Result<String, String> {
    match assert_safe_document_path(Path::new(&abs_path)) {
        Ok(p) => Ok(p.to_string_lossy().into_owned()),
        Err(e) => Err(e.message),
    }
}
