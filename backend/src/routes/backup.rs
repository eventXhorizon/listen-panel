//! Admin-only export of the entire data directory as a streamed `.tar.gz`.
//!
//! Layout in the tarball:
//!   app.db                  — VACUUM INTO snapshot (consistent even while
//!                             backend is serving)
//!   uploads/                — raw user-uploaded media files
//!   tts-cache/              — generated TTS audio cache
//!   config.json, tts.json, asr.json
//!                           — JSON configs with API keys / tokens redacted
//!                             to "***" so a leaked backup doesn't leak keys
//!
//! `backups/` is intentionally excluded (no russian-doll backups).
//!
//! Implementation notes:
//!   * Tar building is sync (the `tar` crate has no async API), so the heavy
//!     work runs inside `spawn_blocking` to keep the runtime responsive.
//!   * Temp files live in $TMPDIR; we unlink them right after opening for
//!     read so a client disconnect / panic during streaming can't leave them
//!     behind (Unix open-fd-after-unlink trick).

use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result as AnyResult};
use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::json;
use sqlx::SqlitePool;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::error::Result;
use crate::paths;

pub fn router() -> Router<crate::AppState> {
    Router::new().route("/settings/backup", get(download))
}

async fn download(State(pool): State<SqlitePool>, user: CurrentUser) -> Result<Response> {
    if !user.is_admin {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "admin only" })),
        )
            .into_response());
    }

    let tmp_dir = std::env::temp_dir();
    let snapshot_path = tmp_dir.join(format!("listen-panel-snapshot-{}.db", Uuid::new_v4()));
    let tarball_path = tmp_dir.join(format!("listen-panel-backup-{}.tar.gz", Uuid::new_v4()));

    // VACUUM INTO produces a consistent copy of the live DB even while writers
    // are active. The target path must not exist; we use a fresh uuid filename.
    // SQLite VACUUM INTO does not accept bound parameters, so we embed the path
    // — safe because we constructed it ourselves and it contains no quotes.
    let snapshot_str = snapshot_path.to_string_lossy().replace('\'', "''");
    sqlx::query(&format!("VACUUM INTO '{snapshot_str}'"))
        .execute(&pool)
        .await
        .context("VACUUM INTO snapshot failed")?;

    let data_dir = paths::data_dir();
    let snap_clone = snapshot_path.clone();
    let tar_clone = tarball_path.clone();

    let build = tokio::task::spawn_blocking(move || build_tarball(&tar_clone, &snap_clone, &data_dir)).await;
    // Snapshot is only useful during the build; delete regardless of outcome.
    let _ = tokio::fs::remove_file(&snapshot_path).await;
    build
        .map_err(|e| anyhow::anyhow!("backup task join error: {e}"))?
        .context("building backup tarball failed")?;

    let file = tokio::fs::File::open(&tarball_path)
        .await
        .context("opening tarball for streaming")?;
    // Unlink after open: the kernel keeps the inode alive until our fd closes,
    // so streaming still works, and no leftover file if the client disconnects.
    let _ = tokio::fs::remove_file(&tarball_path).await;

    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    let filename = format!(
        "listen-panel-backup-{}.tar.gz",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    );

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/gzip")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(body)
        .map_err(|e| anyhow::anyhow!("build response: {e}").into())
}

fn build_tarball(out: &Path, snapshot: &Path, data_dir: &Path) -> AnyResult<()> {
    let f = std::fs::File::create(out).context("create tarball")?;
    let gz = GzEncoder::new(f, Compression::default());
    let mut tar = tar::Builder::new(gz);
    tar.follow_symlinks(false);

    // 1. DB snapshot → app.db at the tarball root.
    tar.append_path_with_name(snapshot, "app.db")
        .context("append app.db")?;

    // 2. Media directories. Skip cleanly if absent (fresh deploy).
    for dir_name in ["uploads", "tts-cache"] {
        let path = data_dir.join(dir_name);
        if path.is_dir() {
            tar.append_dir_all(dir_name, &path)
                .with_context(|| format!("append {dir_name}/"))?;
        }
    }

    // 3. Redacted JSON configs. We rewrite each in-memory before tar-ing.
    for filename in ["config.json", "tts.json", "asr.json"] {
        let path = data_dir.join(filename);
        if !path.is_file() {
            continue;
        }
        let raw = std::fs::read_to_string(&path).with_context(|| format!("read {filename}"))?;
        let body = redact_secrets(&raw).unwrap_or(raw);
        append_bytes(&mut tar, filename, body.as_bytes())
            .with_context(|| format!("append {filename}"))?;
    }

    tar.into_inner()
        .context("finalize tar")?
        .finish()
        .context("finalize gzip")?;
    Ok(())
}

fn append_bytes<W: Write>(tar: &mut tar::Builder<W>, name: &str, bytes: &[u8]) -> AnyResult<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    header.set_mtime(chrono::Utc::now().timestamp() as u64);
    header.set_cksum();
    tar.append_data(&mut header, name, bytes)?;
    Ok(())
}

/// Walks the JSON tree and replaces any string field whose name contains
/// "key", "token", or "secret" (case-insensitive) with `"***"`. Numbers,
/// bools, and structural keys are left alone.
fn redact_secrets(raw: &str) -> AnyResult<String> {
    let mut value: serde_json::Value = serde_json::from_str(raw)?;
    redact_in_place(&mut value);
    Ok(serde_json::to_string_pretty(&value)?)
}

fn redact_in_place(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                let lower = key.to_ascii_lowercase();
                let is_secret =
                    lower.contains("key") || lower.contains("token") || lower.contains("secret");
                if is_secret {
                    if let serde_json::Value::String(s) = child {
                        if !s.is_empty() {
                            *s = "***".to_string();
                        }
                    }
                } else {
                    redact_in_place(child);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                redact_in_place(item);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::redact_secrets;

    #[test]
    fn redacts_api_key_fields() {
        let input = r#"{
            "api_key": "sk-abc123",
            "base_url": "https://api.example.com",
            "nested": { "token": "xyz789", "model": "gpt-4" }
        }"#;
        let out = redact_secrets(input).unwrap();
        assert!(out.contains("\"api_key\": \"***\""));
        assert!(out.contains("\"token\": \"***\""));
        assert!(out.contains("https://api.example.com"));
        assert!(out.contains("\"model\": \"gpt-4\""));
    }

    #[test]
    fn leaves_empty_keys_alone() {
        let input = r#"{"api_key": "", "base_url": "x"}"#;
        let out = redact_secrets(input).unwrap();
        assert!(out.contains("\"api_key\": \"\""));
    }

    #[test]
    fn redacts_keys_case_insensitive() {
        let input = r#"{"ApiKey": "abc", "AUTH_TOKEN": "xyz"}"#;
        let out = redact_secrets(input).unwrap();
        assert!(out.contains("\"ApiKey\": \"***\""));
        assert!(out.contains("\"AUTH_TOKEN\": \"***\""));
    }
}
