//! Per-user API key storage in the OS keychain.
//!
//! The three secrets the binary needs (Replicate / Gemini / Fireworks) are
//! entered once in Settings and stored in the OS keychain — never bundled in
//! the binary, never written to the plaintext settings file, never returned to
//! the JS renderer after entry. Mirrors the `rails.rs` token pattern (keychain
//! + in-memory cache). Falls back to `std::env` so a developer's `.env` keeps
//! working unchanged.

use std::collections::HashMap;
use std::sync::Mutex;

use keyring::Entry;
use serde::{Deserialize, Serialize};

const KEYCHAIN_SERVICE: &str = "gaiare-animation-studio.api-keys";

/// Cache so each call doesn't hit the keychain — an unsigned dev binary
/// re-prompts for the login password on every read. Keyed by account id. The
/// value never leaves this process (same trust boundary as the keychain).
static SECRET_CACHE: Mutex<Option<HashMap<&'static str, String>>> = Mutex::new(None);

#[derive(Debug, Clone, Copy)]
pub enum SecretId {
    Replicate,
    Gemini,
    Fireworks,
}

impl SecretId {
    /// Stable keychain account id — deliberately NOT the env-var name, so
    /// renaming an env var can never orphan a stored keychain entry. Locked.
    fn account(self) -> &'static str {
        match self {
            SecretId::Replicate => "replicate",
            SecretId::Gemini => "gemini",
            SecretId::Fireworks => "fireworks",
        }
    }

    /// Env var consulted as the dev fallback (lets `.env` keep working).
    fn env_var(self) -> &'static str {
        match self {
            SecretId::Replicate => "REPLICATE_API_TOKEN",
            SecretId::Gemini => "GOOGLE_GENERATIVE_AI_API_KEY",
            SecretId::Fireworks => "FIREWORKS_API_KEY",
        }
    }

    fn from_key(key: &str) -> Option<SecretId> {
        match key {
            "replicate" => Some(SecretId::Replicate),
            "gemini" => Some(SecretId::Gemini),
            "fireworks" => Some(SecretId::Fireworks),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SecretError {
    pub message: String,
}

impl SecretError {
    fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }
}

fn cached(account: &str) -> Option<String> {
    let guard = SECRET_CACHE.lock().ok()?;
    guard.as_ref()?.get(account).cloned()
}

fn cache(account: &'static str, value: &str) {
    if let Ok(mut guard) = SECRET_CACHE.lock() {
        guard.get_or_insert_with(HashMap::new).insert(account, value.to_string());
    }
}

fn uncache(account: &str) {
    if let Ok(mut guard) = SECRET_CACHE.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(account);
        }
    }
}

fn entry(id: SecretId) -> Result<Entry, SecretError> {
    Entry::new(KEYCHAIN_SERVICE, id.account())
        .map_err(|e| SecretError::new(format!("keychain: {e}")))
}

/// Resolve a secret: in-memory cache → OS keychain → `std::env` (dev fallback).
/// `None` when unset everywhere — callers surface a "set it in Settings" error.
pub fn get_secret(id: SecretId) -> Option<String> {
    let account = id.account();
    if let Some(value) = cached(account) {
        return Some(value);
    }
    // Keychain. A handle-construction error or a missing entry both fall
    // through to the env fallback rather than aborting the lookup.
    if let Ok(value) = entry(id).and_then(|e| e.get_password().map_err(|_| SecretError::new("no entry"))) {
        cache(account, &value);
        return Some(value);
    }
    match std::env::var(id.env_var()) {
        Ok(value) if !value.is_empty() => Some(value),
        _ => None,
    }
}

#[tauri::command]
pub fn set_secret(key: String, value: String) -> Result<(), SecretError> {
    let id = SecretId::from_key(&key)
        .ok_or_else(|| SecretError::new(format!("unknown secret '{key}'")))?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(SecretError::new("Key value is empty"));
    }
    entry(id)?
        .set_password(trimmed)
        .map_err(|e| SecretError::new(format!("keychain: {e}")))?;
    cache(id.account(), trimmed);
    Ok(())
}

#[tauri::command]
pub fn clear_secret(key: String) -> Result<(), SecretError> {
    let id = SecretId::from_key(&key)
        .ok_or_else(|| SecretError::new(format!("unknown secret '{key}'")))?;
    uncache(id.account());
    // Also drop any dev `.env` value so Clear is definitive — otherwise the env
    // fallback would keep the key "set" and in use after the user cleared it.
    std::env::remove_var(id.env_var());
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(SecretError::new(format!("keychain: {e}"))),
    }
}

/// Whether a key is set (keychain or dev env). Returns ONLY the boolean — the
/// value must never leave this process after entry. Permanent invariant.
#[tauri::command]
pub fn secret_status(key: String) -> bool {
    match SecretId::from_key(&key) {
        Some(id) => get_secret(id).is_some(),
        None => false,
    }
}
