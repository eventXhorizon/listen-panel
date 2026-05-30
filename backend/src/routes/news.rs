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
        .route("/news/_backfill_quality", post(backfill_quality))
        .route("/news/_backfill_furigana", post(backfill_furigana))
}

const LIST_COLS: &str = "id, yt_video_id, source, channel_id, channel_name, title, description, \
    thumbnail_url, published_at, duration_sec, language, topic, difficulty, has_captions, \
    quality, quality_reason, view_count, fetched_at, analyzed_at";

const QUALITY_THRESHOLD: i64 = 7;

const NEWS_FULL_COLS: &str = "id, yt_video_id, source, channel_id, channel_name, title, \
    description, thumbnail_url, published_at, duration_sec, language, topic, difficulty, \
    has_captions, quality, quality_reason, view_count, segments_json, idioms_json, \
    fetched_at, analyzed_at";

const MATERIAL_COLS: &str = "id, user_id, title, language, source_type, source_ref, text, \
    text_source, notes, created_at, updated_at";

#[derive(Debug, Deserialize)]
struct ListQuery {
    source: Option<String>,
    topic: Option<String>,
    /// `short` (<10min) | `medium` (10–30min) | `long` (≥30min)
    duration: Option<String>,
    /// `en` | `ja` — omit to return all.
    language: Option<String>,
}

async fn list(
    State(pool): State<SqlitePool>,
    _user: CurrentUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<NewsItemSummary>>> {
    // Items with NULL quality are kept visible until the backfill endpoint runs
    // (POST /api/news/_backfill_quality) — that way deploying the schema change
    // doesn't make the feed disappear.
    let mut conds: Vec<&'static str> =
        vec!["has_captions = 1", "(quality IS NULL OR quality >= 7)"];
    let source = q
        .source
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let topic = q
        .topic
        .as_deref()
        .filter(|t| matches!(*t, "finance" | "politics" | "tech" | "culture" | "other"))
        .map(|t| t.to_string());
    let language = q
        .language
        .as_deref()
        .filter(|l| matches!(*l, "en" | "ja"))
        .map(|l| l.to_string());
    if source.is_some() {
        conds.push("source = ?");
    }
    if topic.is_some() {
        conds.push("topic = ?");
    }
    if language.is_some() {
        conds.push("language = ?");
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
    if let Some(s) = source.as_deref() {
        query = query.bind(s);
    }
    if let Some(t) = topic.as_deref() {
        query = query.bind(t);
    }
    if let Some(l) = language.as_deref() {
        query = query.bind(l);
    }
    Ok(Json(query.fetch_all(&pool).await?))
}

async fn import(
    State(state): State<crate::AppState>,
    user: CurrentUser,
    Path(news_id): Path<i64>,
) -> Result<Json<Material>> {
    let pool = &state.pool;
    let news = sqlx::query_as::<_, NewsItem>(&format!(
        "SELECT {NEWS_FULL_COLS} FROM news_items WHERE id = ?"
    ))
    .bind(news_id)
    .fetch_optional(pool)
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
    .fetch_optional(pool)
    .await?;
    if let Some(mid) = existing {
        let row = sqlx::query_as::<_, Material>(&format!(
            "SELECT {MATERIAL_COLS} FROM materials WHERE id = ?"
        ))
        .bind(mid)
        .fetch_one(pool)
        .await?;
        return Ok(Json(row));
    }

    let now = Utc::now();
    // Segments are already paragraph-sized (merged in youtube::merge_into_paragraphs).
    // Joining with blank lines gives the Reader paragraph-by-paragraph display.
    let combined_text = segments
        .iter()
        .map(|s| s.text.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");

    let mut tx = pool.begin().await?;

    let material = sqlx::query_as::<_, Material>(&format!(
        "INSERT INTO materials \
         (user_id, title, language, source_type, source_ref, text, text_source, notes, created_at, updated_at) \
         VALUES (?, ?, ?, 'youtube', ?, ?, 'manual_subtitle', '', ?, ?) \
         RETURNING {MATERIAL_COLS}"
    ))
    .bind(user.id)
    .bind(&news.title)
    .bind(&news.language)
    .bind(&news.yt_video_id)
    .bind(&combined_text)
    .bind(now)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;

    // study_status defaults to 'pending'; we'll spawn the study task right after commit.
    let job_id: i64 = sqlx::query_scalar(
        "INSERT INTO transcription_jobs \
           (user_id, material_id, provider, model, language, status, progress, \
            completed_at, created_at, updated_at) \
         VALUES (?, ?, 'youtube_caption', 'youtube_caption', ?, 'succeeded', 100, \
                 ?, ?, ?) \
         RETURNING id",
    )
    .bind(user.id)
    .bind(material.id)
    .bind(&news.language)
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
             (user_id, material_id, word, language, kind, lemma, definition_zh, example_zh, context, mastery) \
             VALUES (?, ?, ?, ?, 'idiom', ?, ?, ?, ?, 0)",
        )
        .bind(user.id)
        .bind(material.id)
        .bind(idiom.phrase.trim())
        .bind(&news.language)
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

    // Auto-trigger the existing study flow (per-segment translation + grammar + usage).
    // This mirrors what `POST /api/transcriptions/:id/study` does, so the imported
    // material behaves identically to one where the user clicked "翻译分析".
    let spawned_state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::study::mark_study_running(&spawned_state.pool, job_id).await {
            tracing::warn!(job_id, "failed to mark study running: {e:#}");
            return;
        }
        tracing::info!(job_id, "starting study generation for imported news");
        if let Err(e) = crate::study::generate_segment_studies_for_job(
            &spawned_state.pool,
            &spawned_state.llm,
            job_id,
        )
        .await
        {
            let error = format!("{e:#}");
            if let Err(mark_err) =
                crate::study::mark_study_failed(&spawned_state.pool, job_id, &error).await
            {
                tracing::warn!(job_id, "failed to mark study failure: {mark_err:#}");
            }
            tracing::warn!(job_id, "news study generation failed: {error}");
        }
    });

    // For Japanese materials, also spawn the furigana annotation task. Runs
    // in parallel with the study task and writes ruby HTML to
    // `transcript_segments.text_with_furigana`.
    if news.language == "ja" {
        let furi_state = state.clone();
        let furi_job_id = job_id;
        tokio::spawn(async move {
            match crate::furigana::generate_for_job(
                &furi_state.pool,
                &furi_state.http,
                &furi_state.llm,
                furi_job_id,
            )
            .await
            {
                Ok(n) => tracing::info!(job_id = furi_job_id, annotated = n, "furigana done"),
                Err(e) => tracing::warn!(job_id = furi_job_id, "furigana failed: {e:#}"),
            }
        });
    }

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
struct BackfillFuriganaResp {
    jobs: usize,
    annotated: usize,
}

/// Admin endpoint that runs the furigana task over every Japanese news-import
/// job whose segments still lack `text_with_furigana`. Picks up legacy material
/// imported before the furigana feature shipped.
async fn backfill_furigana(
    State(state): State<crate::AppState>,
    user: CurrentUser,
) -> Result<Json<BackfillFuriganaResp>> {
    if !user.is_admin {
        return Err(AppError(anyhow::anyhow!(
            "only admin can backfill furigana"
        )));
    }
    // Find all youtube_caption JA jobs that have at least one un-annotated segment.
    let jobs: Vec<(i64,)> = sqlx::query_as(
        "SELECT DISTINCT j.id \
         FROM transcription_jobs j \
         JOIN materials m ON m.id = j.material_id \
         WHERE m.language = 'ja' AND j.provider = 'youtube_caption' \
           AND EXISTS ( \
             SELECT 1 FROM transcript_segments s \
             WHERE s.job_id = j.id AND s.text_with_furigana IS NULL \
           )",
    )
    .fetch_all(&state.pool)
    .await?;

    let total_jobs = jobs.len();
    tracing::info!(total_jobs, "furigana backfill: starting");
    let mut total_annotated = 0usize;
    for (job_id,) in jobs {
        match crate::furigana::generate_for_job(&state.pool, &state.http, &state.llm, job_id).await
        {
            Ok(n) => {
                total_annotated += n;
                tracing::info!(job_id, annotated = n, "furigana backfill: job done");
            }
            Err(e) => {
                tracing::warn!(job_id, "furigana backfill failed: {e:#}");
            }
        }
    }
    tracing::info!(
        total_jobs,
        total_annotated,
        "furigana backfill: complete"
    );
    Ok(Json(BackfillFuriganaResp {
        jobs: total_jobs,
        annotated: total_annotated,
    }))
}

#[derive(Debug, Serialize)]
struct RefreshResp {
    added: usize,
}

#[derive(Debug, Serialize)]
struct BackfillResp {
    scored: usize,
    kept: usize,
    dropped: usize,
    failed: usize,
}

/// Admin endpoint that re-runs DeepSeek analysis on every news_item whose
/// `quality` column is still NULL. Re-uses the existing `analyze()` function
/// so the prompt and parsing logic stay in one place. Returns counts so the
/// caller can see how many items passed the threshold.
async fn backfill_quality(
    State(pool): State<SqlitePool>,
    State(http): State<reqwest::Client>,
    State(llm): State<SharedLlm>,
    user: CurrentUser,
) -> Result<Json<BackfillResp>> {
    if !user.is_admin {
        return Err(AppError(anyhow::anyhow!("only admin can backfill quality")));
    }
    let pending: Vec<(i64, String, String, String, String, String)> = sqlx::query_as(
        "SELECT id, yt_video_id, title, language, segments_json, idioms_json \
         FROM news_items \
         WHERE quality IS NULL AND has_captions = 1 \
         ORDER BY published_at DESC",
    )
    .fetch_all(&pool)
    .await?;

    let total = pending.len();
    tracing::info!(total, "quality backfill: starting");
    let mut scored = 0usize;
    let mut kept = 0usize;
    let mut dropped = 0usize;
    let mut failed = 0usize;

    for (id, video_id, title, language, segments_json, _idioms_json) in pending {
        let Ok(segments) = serde_json::from_str::<Vec<NewsSegment>>(&segments_json) else {
            tracing::warn!(news_id = id, "backfill: bad segments_json, skipping");
            failed += 1;
            continue;
        };
        let transcript = news_fetcher::transcript_for_prompt(&segments);
        let analysis = match news_fetcher::analyze(&http, &llm, &language, &title, &transcript).await {
            Ok(a) => a,
            Err(e) => {
                tracing::warn!(news_id = id, video_id, "backfill analyze failed: {e:#}");
                failed += 1;
                continue;
            }
        };

        let idioms_json = serde_json::to_string(&analysis.idioms).unwrap_or_else(|_| "[]".into());
        let quality_reason = if analysis.quality_reason.is_empty() {
            None
        } else {
            Some(analysis.quality_reason)
        };
        let now = Utc::now();

        sqlx::query(
            "UPDATE news_items \
             SET topic = ?, difficulty = ?, quality = ?, quality_reason = ?, \
                 idioms_json = ?, analyzed_at = ? \
             WHERE id = ?",
        )
        .bind(&analysis.topic)
        .bind(analysis.difficulty)
        .bind(analysis.quality)
        .bind(quality_reason.as_deref())
        .bind(&idioms_json)
        .bind(now)
        .bind(id)
        .execute(&pool)
        .await?;

        scored += 1;
        if analysis.quality >= QUALITY_THRESHOLD {
            kept += 1;
        } else {
            dropped += 1;
        }
        tracing::info!(news_id = id, quality = analysis.quality, "backfill scored");
    }

    tracing::info!(scored, kept, dropped, failed, "quality backfill: done");
    Ok(Json(BackfillResp { scored, kept, dropped, failed }))
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
