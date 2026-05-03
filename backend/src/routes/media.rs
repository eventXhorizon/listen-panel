use std::path::{Path as FsPath, PathBuf};

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use axum::routing::{get, post};
use serde::Serialize;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::error::{AppError, Result};

const UPLOAD_DIR: &str = "data/uploads";
const ALLOWED_EXTS: &[&str] = &["mp4", "mkv", "webm", "mov", "m4v"];
const MAX_UPLOAD: usize = 2 * 1024 * 1024 * 1024; // 2 GiB

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route(
            "/upload",
            post(upload).layer(DefaultBodyLimit::max(MAX_UPLOAD)),
        )
        .route("/media/:file", get(stream))
}

pub async fn ensure_dirs() -> std::io::Result<()> {
    fs::create_dir_all(UPLOAD_DIR).await
}

/// Remove an upload file iff no material still references it as a local
/// `source_ref`. Filename is path-traversal-validated; any failure is
/// logged but never bubbled (cleanup is best-effort).
pub async fn delete_upload_if_orphan(pool: &sqlx::SqlitePool, source_ref: &str) {
    if source_ref.is_empty()
        || source_ref.contains("..")
        || source_ref.contains('/')
        || source_ref.contains('\\')
    {
        return;
    }
    let still_used: i64 = match sqlx::query_scalar(
        "SELECT COUNT(*) FROM materials \
         WHERE source_type = 'local' AND source_ref = ?",
    )
    .bind(source_ref)
    .fetch_one(pool)
    .await
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("orphan check failed for {source_ref}: {e}");
            return;
        }
    };
    if still_used > 0 {
        return;
    }
    let path = std::path::Path::new(UPLOAD_DIR).join(source_ref);
    match fs::remove_file(&path).await {
        Ok(()) => tracing::info!("removed orphan upload: {source_ref}"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("failed to remove {}: {e}", path.display()),
    }
}

#[derive(Serialize)]
struct UploadResp {
    file: String,
}

async fn upload(
    State(pool): State<sqlx::SqlitePool>,
    user: CurrentUser,
    mut multipart: Multipart,
) -> Result<Json<UploadResp>> {
    while let Some(mut field) = multipart.next_field().await.map_err(anyhow::Error::from)? {
        if field.name().unwrap_or("") != "file" {
            continue;
        }
        let original_name = field.file_name().unwrap_or("").to_string();
        let ext = FsPath::new(&original_name)
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if !ALLOWED_EXTS.contains(&ext.as_str()) {
            return Err(AppError(anyhow::anyhow!(
                "unsupported extension '{ext}'; allowed: {ALLOWED_EXTS:?}"
            )));
        }
        let stored = format!("{}.{}", Uuid::new_v4(), ext);
        let path: PathBuf = [UPLOAD_DIR, &stored].iter().collect();
        let mut out = fs::File::create(&path).await?;
        while let Some(chunk) = field.chunk().await.map_err(anyhow::Error::from)? {
            out.write_all(&chunk).await?;
        }
        out.flush().await?;
        if let Err(e) = record_upload_owner(&pool, &stored, user.id).await {
            if let Err(remove_err) = fs::remove_file(&path).await {
                tracing::warn!(
                    path = %path.display(),
                    "failed to remove upload after owner record failure: {remove_err}"
                );
            }
            return Err(e);
        }
        return Ok(Json(UploadResp { file: stored }));
    }
    Err(AppError(anyhow::anyhow!(
        "no 'file' field in multipart body"
    )))
}

async fn stream(
    State(pool): State<sqlx::SqlitePool>,
    user: CurrentUser,
    Path(file): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    if file.is_empty() || file.contains("..") || file.contains('/') || file.contains('\\') {
        return Err(AppError(anyhow::anyhow!("invalid filename")));
    }
    ensure_media_owner(&pool, &file, user.id).await?;
    let path: PathBuf = [UPLOAD_DIR, &file].iter().collect();

    let mut f = match fs::File::open(&path).await {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError(sqlx::Error::RowNotFound.into()));
        }
        Err(e) => return Err(AppError(e.into())),
    };

    let total = f.metadata().await?.len();
    let content_type = guess_content_type(&file);

    let range_hdr = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| parse_range(s, total));

    if let Some((start, end)) = range_hdr {
        let len = end - start + 1;
        f.seek(std::io::SeekFrom::Start(start)).await?;
        let stream = ReaderStream::new(f.take(len));
        let body = Body::from_stream(stream);

        let resp = Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_LENGTH, len.to_string())
            .header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{total}"),
            )
            .body(body)
            .map_err(anyhow::Error::from)?;
        return Ok(resp);
    }

    let stream = ReaderStream::new(f);
    let body = Body::from_stream(stream);
    let resp = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, total.to_string())
        .body(body)
        .map_err(anyhow::Error::from)?;
    Ok(resp)
}

async fn ensure_media_owner(pool: &sqlx::SqlitePool, file: &str, user_id: i64) -> Result<()> {
    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM materials \
         WHERE source_type = 'local' AND source_ref = ? AND user_id = ?",
    )
    .bind(file)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    if exists.is_none() {
        return Err(sqlx::Error::RowNotFound.into());
    }
    Ok(())
}

pub async fn ensure_upload_owner(pool: &sqlx::SqlitePool, file: &str, user_id: i64) -> Result<()> {
    if file.is_empty() || file.contains("..") || file.contains('/') || file.contains('\\') {
        return Err(AppError(anyhow::anyhow!("invalid filename")));
    }
    let exists: Option<String> =
        sqlx::query_scalar("SELECT file FROM uploads WHERE file = ? AND user_id = ?")
            .bind(file)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    if exists.is_none() {
        return Err(sqlx::Error::RowNotFound.into());
    }
    Ok(())
}

async fn record_upload_owner(pool: &sqlx::SqlitePool, file: &str, user_id: i64) -> Result<()> {
    sqlx::query("INSERT INTO uploads (file, user_id) VALUES (?, ?)")
        .bind(file)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}

fn guess_content_type(name: &str) -> &'static str {
    let ext = FsPath::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

fn parse_range(s: &str, total: u64) -> Option<(u64, u64)> {
    let s = s.strip_prefix("bytes=")?;
    let (a, b) = s.split_once('-')?;
    let start: u64 = a.parse().ok()?;
    let end: u64 = if b.is_empty() {
        total.checked_sub(1)?
    } else {
        b.parse().ok()?
    };
    if start > end || end >= total {
        return None;
    }
    Some((start, end))
}
