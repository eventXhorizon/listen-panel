//! English-language interview practice, currently anchored to the Rust Book
//! (chapters 1–20). The schema is generic enough to also host AI Agent topics
//! later (LLM tool use, RAG, multi-agent, evals, agent frameworks).
//!
//!   GET    /api/interview/topics              — full catalog, grouped by category
//!   POST   /api/interview/topics/:id/generate — LLM produces N more Q&A for this
//!                                               topic, owned by current user
//!   GET    /api/interview/questions           — list system + my own questions
//!                                               (filterable by topic_id)
//!   GET    /api/interview/questions/:id       — single question with sample answer
//!   DELETE /api/interview/questions/:id       — remove (only my own; system rows
//!                                               return 404)
//!
//! Seed strategy: at startup the embedded JSON of 100 curated senior-level Q&A
//! is inserted as system rows (user_id IS NULL). Users see them immediately
//! with no LLM cost, and can generate additional variations on top.
//!
//! User isolation: `user_id IS NULL OR user_id = ?` on reads; `user_id = ?`
//! only on delete.

use anyhow::Context;
use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::SqlitePool;

use crate::auth::CurrentUser;
use crate::config::{SharedFeatures, SharedLlm};
use crate::error::{AppError, Result};
use crate::language;
use crate::llm_call::{LlmProvider, call_chat_completions};

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/interview/topics", get(list_topics))
        .route("/interview/topics/:id/generate", post(generate_for_topic))
        .route("/interview/questions", get(list_questions))
        .route(
            "/interview/questions/:id",
            get(get_question).delete(remove_question),
        )
}

/// Short-circuits with 404 when the interview feature flag is off. Pulls the
/// flag out of shared state per-request so a live toggle takes effect without
/// a restart. Applied as a `route_layer` in `api_router` (where AppState is in
/// scope to satisfy the `State<SharedFeatures>` extractor).
pub async fn require_interview_enabled(
    State(features): State<SharedFeatures>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if features.read().await.interview {
        next.run(request).await
    } else {
        (StatusCode::NOT_FOUND, "interview feature disabled").into_response()
    }
}

/// Per-topic question count for one LLM generation pass. Sized so a single
/// DeepSeek call comfortably fits the output token cap.
const GENERATE_DEFAULT_COUNT: usize = 5;
const GENERATE_MAX_COUNT: usize = 8;

/// LLM generation can take 30-60s for 5 senior-level Q&A; the shared client
/// uses a 20s timeout sized for short lookups, so we build our own.
const LLM_TIMEOUT_SECS: u64 = 180;

fn build_llm_http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(LLM_TIMEOUT_SECS))
        .build()
        .map_err(|e| AppError(anyhow::anyhow!("build llm http client: {e}")))
}

// =============== Types ===============

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct InterviewTopic {
    pub id: i64,
    pub slug: String,
    /// Top-level directory bucket: 'rust' | 'ddia' | 'ai_agent'. The UI
    /// renders each track as its own section in the sidebar.
    pub track: String,
    pub category: String,
    pub chapter_no: Option<i64>,
    pub title_en: String,
    pub title_zh: String,
    pub source_url: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Serialize)]
pub struct InterviewQuestion {
    pub id: i64,
    pub topic_id: i64,
    pub topic_slug: String,
    pub topic_title_en: String,
    pub question_en: String,
    pub question_zh: String,
    pub sample_answer_en: String,
    pub sample_answer_zh: String,
    pub key_points: Vec<String>,
    pub follow_ups: Vec<String>,
    pub difficulty: String,
    /// True when this row is system-curated (user_id IS NULL) — the UI hides
    /// the delete button for these.
    pub is_system: bool,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<LlmProvider>,
}

#[derive(Debug, sqlx::FromRow)]
struct QuestionRow {
    id: i64,
    user_id: Option<i64>,
    topic_id: i64,
    topic_slug: String,
    topic_title_en: String,
    question_en: String,
    question_zh: String,
    sample_answer_en: String,
    sample_answer_zh: String,
    key_points_json: String,
    follow_ups_json: String,
    difficulty: String,
    created_at: String,
}

impl QuestionRow {
    fn into_dto(self) -> InterviewQuestion {
        let key_points: Vec<String> =
            serde_json::from_str(&self.key_points_json).unwrap_or_default();
        let follow_ups: Vec<String> =
            serde_json::from_str(&self.follow_ups_json).unwrap_or_default();
        InterviewQuestion {
            id: self.id,
            topic_id: self.topic_id,
            topic_slug: self.topic_slug,
            topic_title_en: self.topic_title_en,
            question_en: self.question_en,
            question_zh: self.question_zh,
            sample_answer_en: self.sample_answer_en,
            sample_answer_zh: self.sample_answer_zh,
            key_points,
            follow_ups,
            difficulty: self.difficulty,
            is_system: self.user_id.is_none(),
            created_at: self.created_at,
            provider: None,
        }
    }
}

const QUESTION_COLS: &str = "q.id, q.user_id, q.topic_id, t.slug AS topic_slug, \
    t.title_en AS topic_title_en, q.question_en, q.question_zh, q.sample_answer_en, \
    q.sample_answer_zh, q.key_points_json, q.follow_ups_json, q.difficulty, q.created_at";

// =============== Topics ===============

async fn list_topics(
    State(pool): State<SqlitePool>,
    _user: CurrentUser,
) -> Result<Json<Vec<InterviewTopic>>> {
    let topics: Vec<InterviewTopic> = sqlx::query_as(
        "SELECT id, slug, track, category, chapter_no, title_en, title_zh, source_url, sort_order \
         FROM interview_topics \
         ORDER BY \
           CASE track WHEN 'rust' THEN 1 WHEN 'ddia' THEN 2 WHEN 'ai_agent' THEN 3 ELSE 99 END, \
           sort_order ASC",
    )
    .fetch_all(&pool)
    .await?;
    Ok(Json(topics))
}

// =============== List / get / delete ===============

#[derive(Debug, Deserialize)]
struct ListQuery {
    topic_id: Option<i64>,
}

async fn list_questions(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<InterviewQuestion>>> {
    let rows: Vec<QuestionRow> = if let Some(topic_id) = q.topic_id {
        sqlx::query_as(&format!(
            "SELECT {QUESTION_COLS} FROM interview_questions q \
             JOIN interview_topics t ON t.id = q.topic_id \
             WHERE q.topic_id = ? AND (q.user_id IS NULL OR q.user_id = ?) \
             ORDER BY q.user_id IS NULL DESC, q.created_at ASC"
        ))
        .bind(topic_id)
        .bind(user.id)
        .fetch_all(&pool)
        .await?
    } else {
        sqlx::query_as(&format!(
            "SELECT {QUESTION_COLS} FROM interview_questions q \
             JOIN interview_topics t ON t.id = q.topic_id \
             WHERE q.user_id IS NULL OR q.user_id = ? \
             ORDER BY t.sort_order ASC, q.user_id IS NULL DESC, q.created_at ASC \
             LIMIT 500"
        ))
        .bind(user.id)
        .fetch_all(&pool)
        .await?
    };
    Ok(Json(rows.into_iter().map(QuestionRow::into_dto).collect()))
}

async fn get_question(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<Response> {
    let row: Option<QuestionRow> = sqlx::query_as(&format!(
        "SELECT {QUESTION_COLS} FROM interview_questions q \
         JOIN interview_topics t ON t.id = q.topic_id \
         WHERE q.id = ? AND (q.user_id IS NULL OR q.user_id = ?)"
    ))
    .bind(id)
    .bind(user.id)
    .fetch_optional(&pool)
    .await?;
    let Some(row) = row else {
        return Ok((StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response());
    };
    Ok(Json(row.into_dto()).into_response())
}

async fn remove_question(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode> {
    let result = sqlx::query("DELETE FROM interview_questions WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&pool)
        .await?;
    if result.rows_affected() == 0 {
        return Ok(StatusCode::NOT_FOUND);
    }
    Ok(StatusCode::NO_CONTENT)
}

// =============== Generate ===============

#[derive(Debug, Deserialize)]
struct GenerateReq {
    /// Optional override; defaults to 5, capped at 8 so one LLM call fits.
    count: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct RawGenerated {
    questions: Vec<RawQuestion>,
}

#[derive(Debug, Deserialize)]
struct RawQuestion {
    #[serde(default)]
    question_en: String,
    #[serde(default)]
    question_zh: String,
    #[serde(default)]
    sample_answer_en: String,
    #[serde(default)]
    sample_answer_zh: String,
    #[serde(default)]
    key_points: Vec<String>,
    #[serde(default)]
    follow_ups: Vec<String>,
}

async fn generate_for_topic(
    State(pool): State<SqlitePool>,
    State(llm): State<SharedLlm>,
    user: CurrentUser,
    Path(topic_id): Path<i64>,
    Json(req): Json<GenerateReq>,
) -> Result<Response> {
    let topic: Option<InterviewTopic> = sqlx::query_as(
        "SELECT id, slug, track, category, chapter_no, title_en, title_zh, source_url, sort_order \
         FROM interview_topics WHERE id = ?",
    )
    .bind(topic_id)
    .fetch_optional(&pool)
    .await?;
    let Some(topic) = topic else {
        return Ok((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "topic not found" })),
        )
            .into_response());
    };

    let count = req
        .count
        .unwrap_or(GENERATE_DEFAULT_COUNT)
        .clamp(1, GENERATE_MAX_COUNT);

    let cfg = llm.read().await.clone();
    let http = build_llm_http()?;
    let body = json!({
        "messages": [
            { "role": "system", "content": language::interview_generate_system_prompt() },
            { "role": "user",   "content": language::interview_generate_user_prompt(
                &topic.track,
                &topic.title_en,
                &topic.title_zh,
                topic.source_url.as_deref(),
                count,
            ) },
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.6
    });
    let outcome = call_chat_completions(&http, &cfg, body, "interview-generate")
        .await
        .map_err(AppError)?;

    let parsed: RawGenerated = serde_json::from_str(&outcome.content)
        .with_context(|| format!("parse interview-generate output: {}", outcome.content))
        .map_err(AppError)?;
    let cleaned = clean_generated(parsed).map_err(AppError)?;

    let mut inserted: Vec<InterviewQuestion> = Vec::with_capacity(cleaned.len());
    for q in cleaned {
        let key_points_json = serde_json::to_string(&q.key_points)?;
        let follow_ups_json = serde_json::to_string(&q.follow_ups)?;
        let new_id: i64 = sqlx::query_scalar(
            "INSERT INTO interview_questions \
               (user_id, topic_id, question_en, question_zh, sample_answer_en, \
                sample_answer_zh, key_points_json, follow_ups_json, difficulty) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'senior') \
             RETURNING id",
        )
        .bind(user.id)
        .bind(topic.id)
        .bind(&q.question_en)
        .bind(&q.question_zh)
        .bind(&q.sample_answer_en)
        .bind(&q.sample_answer_zh)
        .bind(&key_points_json)
        .bind(&follow_ups_json)
        .fetch_one(&pool)
        .await?;

        let row: QuestionRow = sqlx::query_as(&format!(
            "SELECT {QUESTION_COLS} FROM interview_questions q \
             JOIN interview_topics t ON t.id = q.topic_id \
             WHERE q.id = ?"
        ))
        .bind(new_id)
        .fetch_one(&pool)
        .await?;
        let mut dto = row.into_dto();
        dto.provider = Some(outcome.provider);
        inserted.push(dto);
    }

    Ok(Json(json!({
        "topic_id": topic.id,
        "inserted": inserted,
    }))
    .into_response())
}

#[derive(Debug)]
struct CleanedQuestion {
    question_en: String,
    question_zh: String,
    sample_answer_en: String,
    sample_answer_zh: String,
    key_points: Vec<String>,
    follow_ups: Vec<String>,
}

fn clean_generated(raw: RawGenerated) -> anyhow::Result<Vec<CleanedQuestion>> {
    if raw.questions.is_empty() {
        return Err(anyhow::anyhow!("LLM returned no questions"));
    }
    let mut out = Vec::with_capacity(raw.questions.len());
    for (i, q) in raw.questions.into_iter().enumerate() {
        let question_en = q.question_en.trim().to_string();
        let sample_answer_en = q.sample_answer_en.trim().to_string();
        if question_en.is_empty() {
            return Err(anyhow::anyhow!("question #{i} has empty question_en"));
        }
        if sample_answer_en.is_empty() {
            return Err(anyhow::anyhow!("question #{i} has empty sample_answer_en"));
        }
        out.push(CleanedQuestion {
            question_en,
            question_zh: q.question_zh.trim().to_string(),
            sample_answer_en,
            sample_answer_zh: q.sample_answer_zh.trim().to_string(),
            key_points: q
                .key_points
                .into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            follow_ups: q
                .follow_ups
                .into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
        });
    }
    Ok(out)
}

// =============== Seed (startup) ===============

const SEED_JSON: &str = include_str!("../../seeds/interview_questions.json");

#[derive(Debug, Deserialize)]
struct SeedQuestion {
    topic_slug: String,
    question_en: String,
    #[serde(default)]
    question_zh: String,
    sample_answer_en: String,
    #[serde(default)]
    sample_answer_zh: String,
    #[serde(default)]
    key_points: Vec<String>,
    #[serde(default)]
    follow_ups: Vec<String>,
    #[serde(default)]
    difficulty: Option<String>,
}

/// Insert the curated Q&A as system rows (user_id IS NULL). Idempotent on
/// the question text (matches by `(topic_id, question_en)`), but **updates**
/// the answer / key-points / follow-ups when the JSON content differs from
/// what's in the database. This lets us iterate on sample answers (e.g.
/// adding example dialogues) and have the changes flow through on the
/// next backend restart without manually wiping the system rows.
///
/// User-generated rows (`user_id IS NOT NULL`) are never touched.
pub async fn seed_system_questions(pool: &SqlitePool) -> anyhow::Result<()> {
    let questions: Vec<SeedQuestion> = serde_json::from_str(SEED_JSON)
        .context("parse interview_questions.json")?;

    let topic_rows: Vec<(String, i64)> = sqlx::query_as("SELECT slug, id FROM interview_topics")
        .fetch_all(pool)
        .await?;
    let topic_map: std::collections::HashMap<String, i64> = topic_rows.into_iter().collect();

    let mut inserted = 0usize;
    let mut updated = 0usize;
    let mut skipped_unknown_topic = 0usize;
    for q in questions {
        let Some(&topic_id) = topic_map.get(&q.topic_slug) else {
            skipped_unknown_topic += 1;
            continue;
        };

        let key_points_json = serde_json::to_string(&q.key_points)?;
        let follow_ups_json = serde_json::to_string(&q.follow_ups)?;
        let difficulty = q.difficulty.as_deref().unwrap_or("senior");

        // Look up the existing system row for this (topic, question_en).
        let existing: Option<(i64, String, String, String, String, String)> = sqlx::query_as(
            "SELECT id, question_zh, sample_answer_en, sample_answer_zh, \
                    key_points_json, follow_ups_json \
             FROM interview_questions \
             WHERE user_id IS NULL AND topic_id = ? AND question_en = ? \
             LIMIT 1",
        )
        .bind(topic_id)
        .bind(&q.question_en)
        .fetch_optional(pool)
        .await?;

        if let Some((id, ez, ea_en, ea_zh, ekp, efu)) = existing {
            // Update only if any rendered field has changed.
            if ez != q.question_zh
                || ea_en != q.sample_answer_en
                || ea_zh != q.sample_answer_zh
                || ekp != key_points_json
                || efu != follow_ups_json
            {
                sqlx::query(
                    "UPDATE interview_questions \
                     SET question_zh = ?, sample_answer_en = ?, sample_answer_zh = ?, \
                         key_points_json = ?, follow_ups_json = ?, difficulty = ? \
                     WHERE id = ?",
                )
                .bind(&q.question_zh)
                .bind(&q.sample_answer_en)
                .bind(&q.sample_answer_zh)
                .bind(&key_points_json)
                .bind(&follow_ups_json)
                .bind(difficulty)
                .bind(id)
                .execute(pool)
                .await?;
                updated += 1;
            }
            continue;
        }

        sqlx::query(
            "INSERT INTO interview_questions \
               (user_id, topic_id, question_en, question_zh, sample_answer_en, \
                sample_answer_zh, key_points_json, follow_ups_json, difficulty) \
             VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(topic_id)
        .bind(&q.question_en)
        .bind(&q.question_zh)
        .bind(&q.sample_answer_en)
        .bind(&q.sample_answer_zh)
        .bind(&key_points_json)
        .bind(&follow_ups_json)
        .bind(difficulty)
        .execute(pool)
        .await?;
        inserted += 1;
    }

    if inserted > 0 || updated > 0 || skipped_unknown_topic > 0 {
        tracing::info!(
            inserted,
            updated,
            skipped_unknown_topic,
            "interview seed pass complete",
        );
    }
    Ok(())
}
