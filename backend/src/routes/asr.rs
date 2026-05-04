use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio_util::io::ReaderStream;

use crate::auth::{self, CurrentUser};
use crate::config::{AsrConfig, AsrProvider};
use crate::error::{AppError, Result};
use crate::models::{Material, TranscriptSegment, TranscriptionJob};

const JOB_SELECT_COLS: &str = "id, user_id, material_id, provider, model, language, \
    status, progress, error, created_at, updated_at, completed_at";
const SEGMENT_SELECT_COLS: &str = "id, job_id, material_id, start_ms, end_ms, text";

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/materials/:id/transcriptions", post(create).get(list))
        .route("/transcriptions/:id", get(get_one))
        .route("/transcriptions/:id/segments", get(segments))
        .route("/asr/media/:job_id", get(stream_job_media))
        .route("/asr/progress/:job_id", post(update_progress))
}

#[derive(Debug, Serialize)]
struct JobWithSegments {
    job: TranscriptionJob,
    segments: Vec<TranscriptSegment>,
}

#[derive(Debug, Deserialize)]
struct WorkerSegment {
    start: f64,
    end: f64,
    text: String,
}

#[derive(Debug, Deserialize)]
struct WorkerResponse {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    segments: Vec<WorkerSegment>,
}

#[derive(Debug, Serialize)]
struct WorkerRequest<'a> {
    job_id: i64,
    source_type: &'a str,
    source_ref: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    media_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    media_token: Option<&'a str>,
    model: &'a str,
    language: &'a str,
    beam_size: i64,
    vad_filter: bool,
    condition_on_previous_text: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress_token: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
struct ProgressUpdate {
    progress: i64,
    #[serde(default)]
    stage: Option<String>,
}

async fn create(
    State(state): State<crate::AppState>,
    user: CurrentUser,
    Path(material_id): Path<i64>,
) -> Result<Json<TranscriptionJob>> {
    let material = material_for_user(&state.pool, material_id, user.id).await?;
    let cfg = state.asr.read().await.clone();
    if !cfg.configured() {
        return Err(AppError(anyhow::anyhow!(
            "ASR worker not configured; set it on the Settings page"
        )));
    }

    let media_token = auth::new_session_token();
    let token_hash = auth::token_hash(&media_token);
    let now = Utc::now();
    let provider = match cfg.provider {
        AsrProvider::RemoteFasterWhisper => "remote_faster_whisper",
    };

    let job = sqlx::query_as::<_, TranscriptionJob>(&format!(
        "INSERT INTO transcription_jobs \
         (user_id, material_id, provider, model, language, status, progress, media_token_hash, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?) \
         RETURNING {JOB_SELECT_COLS}"
    ))
    .bind(user.id)
    .bind(material_id)
    .bind(provider)
    .bind(&cfg.model)
    .bind(&cfg.language)
    .bind(token_hash)
    .bind(now)
    .bind(now)
    .fetch_one(&state.pool)
    .await?;

    let spawned_state = state.clone();
    let spawned_job_id = job.id;
    tokio::spawn(async move {
        if let Err(e) = run_job(spawned_state, cfg, material, spawned_job_id, media_token).await {
            tracing::error!(job_id = spawned_job_id, "ASR job task failed: {e:?}");
        }
    });

    Ok(Json(job))
}

async fn list(
    State(pool): State<sqlx::SqlitePool>,
    user: CurrentUser,
    Path(material_id): Path<i64>,
) -> Result<Json<Vec<TranscriptionJob>>> {
    ensure_material_owner(&pool, material_id, user.id).await?;
    let rows = sqlx::query_as::<_, TranscriptionJob>(&format!(
        "SELECT {JOB_SELECT_COLS} FROM transcription_jobs \
         WHERE material_id = ? AND user_id = ? \
         ORDER BY created_at DESC"
    ))
    .bind(material_id)
    .bind(user.id)
    .fetch_all(&pool)
    .await?;
    Ok(Json(rows))
}

async fn get_one(
    State(pool): State<sqlx::SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<Json<TranscriptionJob>> {
    let row = sqlx::query_as::<_, TranscriptionJob>(&format!(
        "SELECT {JOB_SELECT_COLS} FROM transcription_jobs \
         WHERE id = ? AND user_id = ?"
    ))
    .bind(id)
    .bind(user.id)
    .fetch_one(&pool)
    .await?;
    Ok(Json(row))
}

async fn segments(
    State(pool): State<sqlx::SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<Json<JobWithSegments>> {
    let job = sqlx::query_as::<_, TranscriptionJob>(&format!(
        "SELECT {JOB_SELECT_COLS} FROM transcription_jobs \
         WHERE id = ? AND user_id = ?"
    ))
    .bind(id)
    .bind(user.id)
    .fetch_one(&pool)
    .await?;
    let segments = sqlx::query_as::<_, TranscriptSegment>(&format!(
        "SELECT {SEGMENT_SELECT_COLS} FROM transcript_segments \
         WHERE job_id = ? \
         ORDER BY start_ms ASC, id ASC"
    ))
    .bind(id)
    .fetch_all(&pool)
    .await?;
    Ok(Json(JobWithSegments { job, segments }))
}

async fn stream_job_media(
    State(pool): State<sqlx::SqlitePool>,
    Path(job_id): Path<i64>,
    headers: HeaderMap,
) -> Result<Response> {
    let Some(token) = bearer_token(&headers) else {
        return Ok(auth::unauthorized());
    };
    let row: (String,) = sqlx::query_as(
        "SELECT m.source_ref FROM transcription_jobs j \
         JOIN materials m ON m.id = j.material_id \
         WHERE j.id = ? \
           AND j.media_token_hash = ? \
           AND j.status IN ('queued', 'running') \
           AND m.source_type = 'local'",
    )
    .bind(job_id)
    .bind(auth::token_hash(token))
    .fetch_one(&pool)
    .await?;
    stream_file(&row.0).await
}

async fn update_progress(
    State(pool): State<sqlx::SqlitePool>,
    Path(job_id): Path<i64>,
    headers: HeaderMap,
    Json(input): Json<ProgressUpdate>,
) -> Result<axum::http::StatusCode> {
    let Some(token) = bearer_token(&headers) else {
        return Ok(axum::http::StatusCode::UNAUTHORIZED);
    };
    let progress = input.progress.clamp(5, 99);
    let result = sqlx::query(
        "UPDATE transcription_jobs \
         SET progress = MAX(progress, ?), updated_at = ? \
         WHERE id = ? \
           AND media_token_hash = ? \
           AND status = 'running'",
    )
    .bind(progress)
    .bind(Utc::now())
    .bind(job_id)
    .bind(auth::token_hash(token))
    .execute(&pool)
    .await?;
    if result.rows_affected() == 0 {
        tracing::debug!(
            job_id,
            progress,
            stage = input.stage.as_deref().unwrap_or(""),
            "ignored ASR progress update"
        );
        return Ok(axum::http::StatusCode::NO_CONTENT);
    }
    tracing::debug!(
        job_id,
        progress,
        stage = input.stage.as_deref().unwrap_or(""),
        "updated ASR progress"
    );
    Ok(axum::http::StatusCode::NO_CONTENT)
}

async fn run_job(
    state: crate::AppState,
    cfg: AsrConfig,
    material: Material,
    job_id: i64,
    media_token: String,
) -> Result<()> {
    tracing::info!(
        job_id,
        material_id = material.id,
        user_id = material.user_id,
        "starting ASR job"
    );
    update_job_running(&state.pool, job_id).await?;

    let result = async {
        let worker = call_worker(&cfg, &material, job_id, &media_token).await?;
        persist_worker_result(&state.pool, job_id, material.id, worker).await
    }
    .await;

    match result {
        Ok(()) => {
            tracing::info!(job_id, "ASR job completed");
        }
        Err(e) => {
            let error = format!("{:#}", e.0);
            mark_job_failed(&state.pool, job_id, &error).await?;
            tracing::warn!(job_id, "ASR job failed: {error}");
        }
    }
    clear_media_token(&state.pool, job_id).await?;
    Ok(())
}

async fn call_worker(
    cfg: &AsrConfig,
    material: &Material,
    job_id: i64,
    media_token: &str,
) -> Result<WorkerResponse> {
    let base_url = cfg.base_url.trim_end_matches('/');
    let url = format!("{base_url}/v1/transcribe");
    let (media_url, worker_media_token) = if material.source_type == "local" {
        (
            Some(format!(
                "{}/api/asr/media/{job_id}",
                cfg.backend_base_url.trim_end_matches('/')
            )),
            Some(media_token),
        )
    } else {
        (None, None)
    };
    let progress_url = Some(format!(
        "{}/api/asr/progress/{job_id}",
        cfg.backend_base_url.trim_end_matches('/')
    ));
    let req = WorkerRequest {
        job_id,
        source_type: &material.source_type,
        source_ref: &material.source_ref,
        media_url,
        media_token: worker_media_token,
        model: &cfg.model,
        language: &cfg.language,
        beam_size: cfg.beam_size,
        vad_filter: cfg.vad_filter,
        condition_on_previous_text: cfg.condition_on_previous_text,
        progress_url,
        progress_token: Some(media_token),
    };

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(cfg.timeout_seconds.max(60)))
        .build()?;
    let mut builder = client.post(url).json(&req);
    if !cfg.api_token.trim().is_empty() {
        builder = builder.bearer_auth(cfg.api_token.trim());
    }
    let res = builder.send().await?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        let trimmed = body.chars().take(500).collect::<String>();
        return Err(AppError(anyhow::anyhow!(
            "ASR worker returned {status}: {trimmed}"
        )));
    }
    let parsed = res.json::<WorkerResponse>().await?;
    if parsed.segments.is_empty() && parsed.text.as_deref().unwrap_or("").trim().is_empty() {
        return Err(AppError(anyhow::anyhow!(
            "ASR worker returned no transcript"
        )));
    }
    Ok(parsed)
}

async fn persist_worker_result(
    pool: &sqlx::SqlitePool,
    job_id: i64,
    material_id: i64,
    worker: WorkerResponse,
) -> Result<()> {
    let mut segments = worker.segments;
    if segments.is_empty() {
        segments.push(WorkerSegment {
            start: 0.0,
            end: 0.0,
            text: worker.text.unwrap_or_default(),
        });
    }
    let text = segments
        .iter()
        .map(|s| s.text.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if text.is_empty() {
        return Err(AppError(anyhow::anyhow!(
            "ASR worker returned only blank text"
        )));
    }

    let now = Utc::now();
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM transcript_segments WHERE job_id = ?")
        .bind(job_id)
        .execute(&mut *tx)
        .await?;
    for segment in segments {
        let text = segment.text.trim();
        if text.is_empty() {
            continue;
        }
        let start_ms = seconds_to_ms(segment.start);
        let end_ms = seconds_to_ms(segment.end).max(start_ms);
        sqlx::query(
            "INSERT INTO transcript_segments (job_id, material_id, start_ms, end_ms, text) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(job_id)
        .bind(material_id)
        .bind(start_ms)
        .bind(end_ms)
        .bind(text)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("UPDATE materials SET text = ?, updated_at = ? WHERE id = ?")
        .bind(&text)
        .bind(now)
        .bind(material_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE transcription_jobs \
         SET status = 'succeeded', progress = 100, error = NULL, updated_at = ?, completed_at = ? \
         WHERE id = ?",
    )
    .bind(now)
    .bind(now)
    .bind(job_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn update_job_running(pool: &sqlx::SqlitePool, job_id: i64) -> Result<()> {
    sqlx::query(
        "UPDATE transcription_jobs \
         SET status = 'running', progress = 5, updated_at = ? \
         WHERE id = ?",
    )
    .bind(Utc::now())
    .bind(job_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_job_failed(pool: &sqlx::SqlitePool, job_id: i64, error: &str) -> Result<()> {
    sqlx::query(
        "UPDATE transcription_jobs \
         SET status = 'failed', progress = 100, error = ?, updated_at = ?, completed_at = ? \
         WHERE id = ?",
    )
    .bind(error.chars().take(2000).collect::<String>())
    .bind(Utc::now())
    .bind(Utc::now())
    .bind(job_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn clear_media_token(pool: &sqlx::SqlitePool, job_id: i64) -> Result<()> {
    sqlx::query("UPDATE transcription_jobs SET media_token_hash = NULL WHERE id = ?")
        .bind(job_id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn material_for_user(
    pool: &sqlx::SqlitePool,
    material_id: i64,
    user_id: i64,
) -> Result<Material> {
    Ok(sqlx::query_as::<_, Material>(
        "SELECT id, user_id, title, source_type, source_ref, text, notes, created_at, updated_at \
         FROM materials \
         WHERE id = ? AND user_id = ?",
    )
    .bind(material_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?)
}

async fn ensure_material_owner(
    pool: &sqlx::SqlitePool,
    material_id: i64,
    user_id: i64,
) -> Result<()> {
    let exists: Option<i64> =
        sqlx::query_scalar("SELECT id FROM materials WHERE id = ? AND user_id = ?")
            .bind(material_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    if exists.is_none() {
        return Err(sqlx::Error::RowNotFound.into());
    }
    Ok(())
}

async fn stream_file(file: &str) -> Result<Response> {
    if file.is_empty() || file.contains("..") || file.contains('/') || file.contains('\\') {
        return Err(AppError(anyhow::anyhow!("invalid filename")));
    }
    let path = crate::paths::uploads_dir().join(file);
    let f = match fs::File::open(&path).await {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError(sqlx::Error::RowNotFound.into()));
        }
        Err(e) => return Err(AppError(e.into())),
    };
    let total = f.metadata().await?.len();
    let body = Body::from_stream(ReaderStream::new(f));
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&total.to_string())?,
    );
    Ok((headers, body).into_response())
}

fn seconds_to_ms(seconds: f64) -> i64 {
    if !seconds.is_finite() {
        return 0;
    }
    (seconds.max(0.0) * 1000.0).round() as i64
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    raw.strip_prefix("Bearer ").filter(|s| !s.is_empty())
}
