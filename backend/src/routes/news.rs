//! News feed endpoints.
//!
//! GET  /api/news                — list cached news items (filterable by source/topic/duration).
//! POST /api/news/:id/import     — materialize a news item into the current user's library:
//!                                 creates a Material, a synthetic transcription_job, expands
//!                                 cached segments into transcript_segments, and seeds vocab
//!                                 with kind='idiom' from the pre-analyzed idioms.

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::auth::CurrentUser;
use crate::config::SharedLlm;
use crate::error::{AppError, Result};
use crate::models::{Material, NewsIdiom, NewsItem, NewsItemSummary, NewsSegment};
use crate::news_fetcher;

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/news", get(list))
        .route("/news/:id", axum::routing::delete(delete_one))
        .route("/news/:id/import", post(import))
        .route("/news/_refresh", post(refresh))
}

const LIST_COLS: &str = "id, yt_video_id, source, channel_id, channel_name, title, description, \
    thumbnail_url, published_at, duration_sec, language, topic, difficulty, has_captions, \
    fetched_at, analyzed_at";

const NEWS_FULL_COLS: &str = "id, yt_video_id, source, channel_id, channel_name, title, \
    description, thumbnail_url, published_at, duration_sec, language, topic, difficulty, \
    has_captions, segments_json, idioms_json, fetched_at, analyzed_at";

const MATERIAL_COLS: &str = "id, user_id, title, language, source_type, source_ref, text, \
    text_source, notes, created_at, updated_at";

#[derive(Debug, Deserialize)]
struct ListQuery {
    source: Option<String>,
    topic: Option<String>,
    /// `short` (<10min) | `medium` (10–30min) | `long` (≥30min)
    duration: Option<String>,
}

async fn list(
    State(pool): State<SqlitePool>,
    _user: CurrentUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<NewsItemSummary>>> {
    let mut conds: Vec<&'static str> = vec!["has_captions = 1"];
    let source = q.source.as_deref().filter(|s| {
        matches!(*s, "cnbc" | "bloomberg" | "wsj" | "ft")
    });
    let topic = q.topic.as_deref().filter(|t| {
        matches!(*t, "finance" | "politics" | "tech" | "culture" | "other")
    });
    if source.is_some() {
        conds.push("source = ?");
    }
    if topic.is_some() {
        conds.push("topic = ?");
    }
    match q.duration.as_deref() {
        Some("short") => conds.push("duration_sec < 600"),
        Some("medium") => conds.push("duration_sec >= 600 AND duration_sec < 1800"),
        Some("long") => conds.push("duration_sec >= 1800"),
        _ => {}
    }

    let sql = format!(
        "SELECT {LIST_COLS} FROM news_items WHERE {} \
         ORDER BY published_at DESC LIMIT 200",
        conds.join(" AND ")
    );
    let mut query = sqlx::query_as::<_, NewsItemSummary>(&sql);
    if let Some(s) = source {
        query = query.bind(s);
    }
    if let Some(t) = topic {
        query = query.bind(t);
    }
    Ok(Json(query.fetch_all(&pool).await?))
}

async fn import(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(news_id): Path<i64>,
) -> Result<Json<Material>> {
    let news = sqlx::query_as::<_, NewsItem>(&format!(
        "SELECT {NEWS_FULL_COLS} FROM news_items WHERE id = ?"
    ))
    .bind(news_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError(anyhow::anyhow!("news item not found")))?;

    if news.has_captions == 0 {
        return Err(AppError(anyhow::anyhow!(
            "news item has no captions yet; cannot import"
        )));
    }

    let segments: Vec<NewsSegment> = serde_json::from_str(&news.segments_json)
        .map_err(|e| AppError(anyhow::anyhow!("bad segments_json: {e}")))?;
    let idioms: Vec<NewsIdiom> = serde_json::from_str(&news.idioms_json)
        .map_err(|e| AppError(anyhow::anyhow!("bad idioms_json: {e}")))?;

    let existing: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM materials \
         WHERE user_id = ? AND source_type = 'youtube' AND source_ref = ?",
    )
    .bind(user.id)
    .bind(&news.yt_video_id)
    .fetch_optional(&pool)
    .await?;
    if let Some(mid) = existing {
        let row = sqlx::query_as::<_, Material>(&format!(
            "SELECT {MATERIAL_COLS} FROM materials WHERE id = ?"
        ))
        .bind(mid)
        .fetch_one(&pool)
        .await?;
        return Ok(Json(row));
    }

    let now = Utc::now();
    let combined_text = segments
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");

    let mut tx = pool.begin().await?;

    let material = sqlx::query_as::<_, Material>(&format!(
        "INSERT INTO materials \
         (user_id, title, language, source_type, source_ref, text, text_source, notes, created_at, updated_at) \
         VALUES (?, ?, 'en', 'youtube', ?, ?, 'manual_subtitle', '', ?, ?) \
         RETURNING {MATERIAL_COLS}"
    ))
    .bind(user.id)
    .bind(&news.title)
    .bind(&news.yt_video_id)
    .bind(&combined_text)
    .bind(now)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;

    let job_id: i64 = sqlx::query_scalar(
        "INSERT INTO transcription_jobs \
           (user_id, material_id, provider, model, language, status, progress, \
            study_status, completed_at, created_at, updated_at) \
         VALUES (?, ?, 'youtube_caption', 'youtube_caption', 'en', 'succeeded', 100, \
                 'skipped', ?, ?, ?) \
         RETURNING id",
    )
    .bind(user.id)
    .bind(material.id)
    .bind(now)
    .bind(now)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;

    for seg in &segments {
        if seg.text.trim().is_empty() {
            continue;
        }
        sqlx::query(
            "INSERT INTO transcript_segments (job_id, material_id, start_ms, end_ms, text) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(job_id)
        .bind(material.id)
        .bind(seg.start_ms)
        .bind(seg.end_ms.max(seg.start_ms))
        .bind(seg.text.trim())
        .execute(&mut *tx)
        .await?;
    }

    for idiom in &idioms {
        if idiom.phrase.trim().is_empty() {
            continue;
        }
        sqlx::query(
            "INSERT INTO vocab \
             (material_id, word, language, kind, lemma, definition_zh, example_zh, context, mastery) \
             VALUES (?, ?, 'en', 'idiom', ?, ?, ?, ?, 0)",
        )
        .bind(material.id)
        .bind(idiom.phrase.trim())
        .bind(idiom.phrase.trim())
        .bind(idiom.meaning_zh.trim())
        .bind(idiom.usage_note.as_deref().unwrap_or("").trim())
        .bind(idiom.anchor_sentence.trim())
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    tracing::info!(
        material_id = material.id,
        news_id = news.id,
        segments = segments.len(),
        idioms = idioms.len(),
        "imported news item"
    );

    Ok(Json(material))
}

async fn delete_one(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(news_id): Path<i64>,
) -> Result<axum::http::StatusCode> {
    if !user.is_admin {
        return Err(AppError(anyhow::anyhow!(
            "only admin can delete news items"
        )));
    }
    let result = sqlx::query("DELETE FROM news_items WHERE id = ?")
        .bind(news_id)
        .execute(&pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound.into());
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize)]
struct RefreshResp {
    added: usize,
}

/// Dev/admin trigger that runs the news fetcher once on demand.
/// Reads YOUTUBE_API_KEY from env each call so the user can rotate keys
/// without restarting the server.
async fn refresh(
    State(pool): State<SqlitePool>,
    State(http): State<reqwest::Client>,
    State(llm): State<SharedLlm>,
    user: CurrentUser,
) -> Result<Json<RefreshResp>> {
    if !user.is_admin {
        return Err(AppError(anyhow::anyhow!(
            "only admin can trigger news refresh"
        )));
    }
    let api_key = std::env::var("YOUTUBE_API_KEY").unwrap_or_default();
    if api_key.is_empty() {
        return Err(AppError(anyhow::anyhow!(
            "YOUTUBE_API_KEY env var not set"
        )));
    }
    let added = news_fetcher::run_once(&pool, &http, &llm, &api_key).await?;
    Ok(Json(RefreshResp { added }))
}
