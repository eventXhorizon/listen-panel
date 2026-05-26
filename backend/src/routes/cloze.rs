//! Cloze (fill-in-the-blank) practice generated from the global
//! `news_items` transcript cache.
//!
//!   GET    /api/cloze/news              — high-quality news items eligible
//!                                          as cloze sources (filter ready
//!                                          for the picker UI)
//!   POST   /api/cloze/exercises         — { news_id, difficulty? } → ask
//!                                          the LLM for a simplified article
//!                                          + blanks, validate, persist,
//!                                          return the new exercise
//!   GET    /api/cloze/exercises         — list this user's saved exercises
//!                                          (summary projection, no blanks)
//!   GET    /api/cloze/exercises/:id     — full exercise (for the "do this
//!                                          one" view, blanks included)
//!   POST   /api/cloze/exercises/:id/grade — { answers: [...] } → per-blank
//!                                          status + score; also overwrites
//!                                          last_attempt_json on the row
//!   DELETE /api/cloze/exercises/:id     — remove one
//!
//! User isolation is enforced via `WHERE user_id = ?` on every read.

use anyhow::Context;
use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::SqlitePool;

use crate::auth::CurrentUser;
use crate::config::SharedLlm;
use crate::error::{AppError, Result};
use crate::language;
use crate::llm_call::{LlmProvider, call_chat_completions};
use crate::models::{NewsItemSummary, NewsSegment};

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/cloze/news", get(list_candidates))
        .route("/cloze/exercises", post(create).get(list_mine))
        .route("/cloze/exercises/:id", get(get_one).delete(remove))
        .route("/cloze/exercises/:id/grade", post(grade))
}

// ---------------- Source picker ----------------

const SUMMARY_COLS: &str = "id, yt_video_id, source, channel_id, channel_name, title, \
    description, thumbnail_url, published_at, duration_sec, language, topic, difficulty, \
    has_captions, quality, quality_reason, view_count, fetched_at, analyzed_at";

#[derive(Debug, Deserialize)]
struct CandidateQuery {
    topic: Option<String>,
    source: Option<String>,
    difficulty: Option<i64>,
}

/// Quality threshold for cloze sources. Slightly stricter than the news feed
/// (which lets NULL-quality items through during backfill) — we don't want
/// the user to invest time practicing on a low-quality piece.
const QUALITY_FLOOR: i64 = 7;
const MIN_DURATION_SEC: i64 = 60;
const MAX_DURATION_SEC: i64 = 900;
const CANDIDATE_LIMIT: i64 = 50;

async fn list_candidates(
    State(pool): State<SqlitePool>,
    _user: CurrentUser,
    Query(q): Query<CandidateQuery>,
) -> Result<Json<Vec<NewsItemSummary>>> {
    // Build a parameterized query incrementally. We deliberately build the
    // SQL string out of static fragments (and only bind values) so there's
    // no chance of injection from query params.
    let mut sql = format!(
        "SELECT {SUMMARY_COLS} FROM news_items \
         WHERE has_captions = 1 \
           AND language = 'en' \
           AND quality >= ? \
           AND duration_sec BETWEEN ? AND ? \
           AND segments_json != '[]'"
    );
    if q.topic.is_some() {
        sql.push_str(" AND topic = ?");
    }
    if q.source.is_some() {
        sql.push_str(" AND source = ?");
    }
    if q.difficulty.is_some() {
        sql.push_str(" AND difficulty = ?");
    }
    sql.push_str(" ORDER BY published_at DESC LIMIT ?");

    let mut query = sqlx::query_as::<_, NewsItemSummary>(&sql)
        .bind(QUALITY_FLOOR)
        .bind(MIN_DURATION_SEC)
        .bind(MAX_DURATION_SEC);
    if let Some(topic) = q.topic.as_deref() {
        query = query.bind(topic);
    }
    if let Some(source) = q.source.as_deref() {
        query = query.bind(source);
    }
    if let Some(difficulty) = q.difficulty {
        query = query.bind(difficulty);
    }
    let rows = query.bind(CANDIDATE_LIMIT).fetch_all(&pool).await?;
    Ok(Json(rows))
}

// ---------------- Exercise types ----------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClozeBlank {
    pub answer: String,
    pub category: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    pub explanation_zh: String,
}

#[derive(Debug, Serialize)]
pub struct ClozeExercise {
    pub id: i64,
    pub news_id: i64,
    pub source_title: String,
    pub source_topic: String,
    pub source_language: String,
    pub difficulty: String,
    pub simplified_text: String,
    pub blanks: Vec<ClozeBlank>,
    pub last_attempt: Option<LastAttempt>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<LlmProvider>,
}

/// Same as ClozeExercise but without `simplified_text` / `blanks` — used for
/// the "my exercises" list to avoid shipping every full article over the wire.
#[derive(Debug, Serialize)]
pub struct ClozeExerciseSummary {
    pub id: i64,
    pub news_id: i64,
    pub source_title: String,
    pub source_topic: String,
    pub source_language: String,
    pub difficulty: String,
    pub blank_count: i64,
    pub last_attempt: Option<LastAttempt>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LastAttempt {
    pub answers: Vec<String>,
    pub score: f64,
    pub graded_at: String,
}

#[derive(Debug, sqlx::FromRow)]
struct ExerciseRow {
    id: i64,
    news_id: i64,
    source_title: String,
    source_topic: String,
    source_language: String,
    difficulty: String,
    simplified_text: String,
    blanks_json: String,
    last_attempt_json: Option<String>,
    created_at: String,
}

impl ExerciseRow {
    fn into_full(self) -> ClozeExercise {
        let blanks: Vec<ClozeBlank> =
            serde_json::from_str(&self.blanks_json).unwrap_or_default();
        let last_attempt: Option<LastAttempt> = self
            .last_attempt_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok());
        ClozeExercise {
            id: self.id,
            news_id: self.news_id,
            source_title: self.source_title,
            source_topic: self.source_topic,
            source_language: self.source_language,
            difficulty: self.difficulty,
            simplified_text: self.simplified_text,
            blanks,
            last_attempt,
            created_at: self.created_at,
            provider: None,
        }
    }

    fn into_summary(self) -> ClozeExerciseSummary {
        let blank_count: i64 =
            serde_json::from_str::<Vec<serde_json::Value>>(&self.blanks_json)
                .map(|v| v.len() as i64)
                .unwrap_or(0);
        let last_attempt: Option<LastAttempt> = self
            .last_attempt_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok());
        ClozeExerciseSummary {
            id: self.id,
            news_id: self.news_id,
            source_title: self.source_title,
            source_topic: self.source_topic,
            source_language: self.source_language,
            difficulty: self.difficulty,
            blank_count,
            last_attempt,
            created_at: self.created_at,
        }
    }
}

// ---------------- Generate ----------------

#[derive(Debug, Deserialize)]
pub struct CreateReq {
    pub news_id: i64,
    /// 'easy' | 'normal' | 'hard'. Defaults to 'normal'.
    #[serde(default)]
    pub difficulty: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct NewsForCloze {
    id: i64,
    title: String,
    topic: String,
    language: String,
    has_captions: i64,
    quality: Option<i64>,
    segments_json: String,
}

async fn create(
    State(pool): State<SqlitePool>,
    State(http): State<reqwest::Client>,
    State(llm): State<SharedLlm>,
    user: CurrentUser,
    Json(req): Json<CreateReq>,
) -> Result<Response> {
    let difficulty = normalize_difficulty(req.difficulty.as_deref());

    let news: Option<NewsForCloze> = sqlx::query_as(
        "SELECT id, title, topic, language, has_captions, quality, segments_json \
         FROM news_items WHERE id = ?",
    )
    .bind(req.news_id)
    .fetch_optional(&pool)
    .await?;
    let Some(news) = news else {
        return Ok((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "news item not found" })),
        )
            .into_response());
    };
    if news.has_captions == 0 {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "news item has no captions; cannot generate cloze" })),
        )
            .into_response());
    }
    // Soft block on low quality — gives the picker the choice to retry but
    // doesn't burn LLM tokens on noise.
    if let Some(q) = news.quality {
        if q < QUALITY_FLOOR {
            return Ok((
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": format!("news quality {q} is below threshold {QUALITY_FLOOR}")
                })),
            )
                .into_response());
        }
    }

    let segments: Vec<NewsSegment> = serde_json::from_str(&news.segments_json)
        .map_err(|e| AppError(anyhow::anyhow!("bad segments_json: {e}")))?;
    let transcript = segments
        .iter()
        .map(|s| s.text.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");

    if transcript.chars().count() < 200 {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "transcript is too short to generate a worthwhile cloze" })),
        )
            .into_response());
    }

    let cfg = llm.read().await.clone();
    let body = json!({
        "messages": [
            { "role": "system", "content": language::cloze_generate_system_prompt() },
            { "role": "user",   "content": language::cloze_generate_user_prompt(&transcript, difficulty) },
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.4
    });
    let outcome = call_chat_completions(&http, &cfg, body, "cloze-generate")
        .await
        .map_err(AppError)?;

    let parsed: GenerateLlmOutput = serde_json::from_str(&outcome.content)
        .with_context(|| format!("parse cloze-generate output: {}", outcome.content))
        .map_err(AppError)?;
    let cleaned = validate_and_clean(parsed).map_err(AppError)?;

    let blanks_json = serde_json::to_string(&cleaned.blanks)?;
    let row: ExerciseRow = sqlx::query_as(
        "INSERT INTO cloze_exercises \
           (user_id, news_id, source_title, source_topic, source_language, difficulty, \
            simplified_text, blanks_json) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
         RETURNING id, news_id, source_title, source_topic, source_language, difficulty, \
                   simplified_text, blanks_json, last_attempt_json, created_at",
    )
    .bind(user.id)
    .bind(news.id)
    .bind(&news.title)
    .bind(&news.topic)
    .bind(&news.language)
    .bind(difficulty)
    .bind(&cleaned.simplified_text)
    .bind(&blanks_json)
    .fetch_one(&pool)
    .await?;

    let mut exercise = row.into_full();
    exercise.provider = Some(outcome.provider);
    Ok(Json(exercise).into_response())
}

fn normalize_difficulty(d: Option<&str>) -> &'static str {
    match d.map(str::trim) {
        Some("easy") => "easy",
        Some("hard") => "hard",
        _ => "normal",
    }
}

#[derive(Debug)]
struct CleanedGen {
    simplified_text: String,
    blanks: Vec<ClozeBlank>,
}

/// Validate the LLM output:
/// - `{{N}}` indices must be 0..len, each appearing exactly once
/// - blanks array length must match the placeholder count
/// - blank fields must be non-empty after trimming
fn validate_and_clean(raw: GenerateLlmOutput) -> anyhow::Result<CleanedGen> {
    let simplified_text = raw.simplified_text.trim().to_string();
    if simplified_text.is_empty() {
        return Err(anyhow::anyhow!("LLM returned empty simplified_text"));
    }

    let blanks: Vec<ClozeBlank> = raw
        .blanks
        .into_iter()
        .map(|b| ClozeBlank {
            answer: b.answer.trim().to_string(),
            category: normalize_category(b.category.trim()),
            hint: b
                .hint
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            explanation_zh: b.explanation_zh.trim().to_string(),
        })
        .collect();
    if blanks.is_empty() {
        return Err(anyhow::anyhow!("LLM returned no blanks"));
    }
    for (i, b) in blanks.iter().enumerate() {
        if b.answer.is_empty() {
            return Err(anyhow::anyhow!("blank #{i} has empty answer"));
        }
        if b.explanation_zh.is_empty() {
            return Err(anyhow::anyhow!("blank #{i} has empty explanation_zh"));
        }
    }

    // Count `{{N}}` occurrences and check indices are exactly 0..blanks.len(),
    // each appearing exactly once, in any order.
    let placeholder_re = regex::Regex::new(r"\{\{(\d+)\}\}").unwrap();
    let mut seen = vec![0usize; blanks.len()];
    for cap in placeholder_re.captures_iter(&simplified_text) {
        let idx: usize = cap[1]
            .parse()
            .map_err(|_| anyhow::anyhow!("placeholder index parse error"))?;
        if idx >= blanks.len() {
            return Err(anyhow::anyhow!(
                "placeholder {{{idx}}} is out of range (have {} blanks)",
                blanks.len()
            ));
        }
        seen[idx] += 1;
    }
    for (i, count) in seen.iter().enumerate() {
        if *count == 0 {
            return Err(anyhow::anyhow!("blank #{i} has no placeholder in text"));
        }
        if *count > 1 {
            return Err(anyhow::anyhow!(
                "blank #{i} placeholder appears {count} times (must be exactly 1)"
            ));
        }
    }

    Ok(CleanedGen {
        simplified_text,
        blanks,
    })
}

fn normalize_category(c: &str) -> String {
    // Accept all currently supported tags. Unknown LLM outputs fall back to
    // 'word' so a bad category never breaks rendering — the explanation_zh
    // still carries the real meaning.
    let lc = c.to_ascii_lowercase();
    match lc.as_str() {
        // Lexical
        "word" | "phrase" | "idiom" | "collocation"
        // Grammar
        | "preposition" | "article" | "connective" | "verb_form" | "modal" => lc,
        // Common LLM synonyms — quietly map to our canonical tag.
        "phrasal" | "phrasal_verb" | "phrasal verb" => "phrase".to_string(),
        "conjunction" | "connector" => "connective".to_string(),
        "tense" | "verb form" | "verb-form" => "verb_form".to_string(),
        "modal_verb" | "modal verb" => "modal".to_string(),
        _ => "word".to_string(),
    }
}

// ---------------- List / get / delete ----------------

async fn list_mine(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
) -> Result<Json<Vec<ClozeExerciseSummary>>> {
    let rows: Vec<ExerciseRow> = sqlx::query_as(
        "SELECT id, news_id, source_title, source_topic, source_language, difficulty, \
                simplified_text, blanks_json, last_attempt_json, created_at \
         FROM cloze_exercises \
         WHERE user_id = ? \
         ORDER BY created_at DESC \
         LIMIT 200",
    )
    .bind(user.id)
    .fetch_all(&pool)
    .await?;
    Ok(Json(rows.into_iter().map(ExerciseRow::into_summary).collect()))
}

async fn get_one(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<Response> {
    let row: Option<ExerciseRow> = sqlx::query_as(
        "SELECT id, news_id, source_title, source_topic, source_language, difficulty, \
                simplified_text, blanks_json, last_attempt_json, created_at \
         FROM cloze_exercises WHERE id = ? AND user_id = ?",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&pool)
    .await?;
    let Some(row) = row else {
        return Ok((StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response());
    };
    Ok(Json(row.into_full()).into_response())
}

async fn remove(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode> {
    let result = sqlx::query("DELETE FROM cloze_exercises WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&pool)
        .await?;
    if result.rows_affected() == 0 {
        return Ok(StatusCode::NOT_FOUND);
    }
    Ok(StatusCode::NO_CONTENT)
}

// ---------------- Grade ----------------

#[derive(Debug, Deserialize)]
pub struct GradeReq {
    pub answers: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct BlankResult {
    pub index: usize,
    pub user_answer: String,
    pub correct_answer: String,
    /// 'correct' | 'close' | 'wrong' | 'empty'
    pub status: &'static str,
    pub explanation_zh: String,
}

#[derive(Debug, Serialize)]
pub struct GradeResponse {
    pub results: Vec<BlankResult>,
    /// Fraction of blanks correct (exact match only). Range 0.0..=1.0.
    pub score: f64,
    /// Echoed for the UI's summary line ("8 / 12 correct").
    pub correct_count: usize,
    pub total_count: usize,
}

async fn grade(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(req): Json<GradeReq>,
) -> Result<Response> {
    let row: Option<ExerciseRow> = sqlx::query_as(
        "SELECT id, news_id, source_title, source_topic, source_language, difficulty, \
                simplified_text, blanks_json, last_attempt_json, created_at \
         FROM cloze_exercises WHERE id = ? AND user_id = ?",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&pool)
    .await?;
    let Some(row) = row else {
        return Ok((StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response());
    };

    let blanks: Vec<ClozeBlank> = serde_json::from_str(&row.blanks_json)
        .map_err(|e| AppError(anyhow::anyhow!("bad blanks_json: {e}")))?;

    let answers = req.answers;
    let results: Vec<BlankResult> = blanks
        .iter()
        .enumerate()
        .map(|(i, blank)| {
            let raw_user = answers.get(i).cloned().unwrap_or_default();
            let trimmed = raw_user.trim();
            let status = if trimmed.is_empty() {
                "empty"
            } else {
                judge(trimmed, &blank.answer)
            };
            BlankResult {
                index: i,
                user_answer: trimmed.to_string(),
                correct_answer: blank.answer.clone(),
                status,
                explanation_zh: blank.explanation_zh.clone(),
            }
        })
        .collect();

    let correct_count = results.iter().filter(|r| r.status == "correct").count();
    let total_count = results.len();
    let score = if total_count == 0 {
        0.0
    } else {
        correct_count as f64 / total_count as f64
    };

    let snapshot = LastAttempt {
        answers: results.iter().map(|r| r.user_answer.clone()).collect(),
        score,
        graded_at: Utc::now().to_rfc3339(),
    };
    let snapshot_json = serde_json::to_string(&snapshot)?;
    sqlx::query(
        "UPDATE cloze_exercises SET last_attempt_json = ? WHERE id = ? AND user_id = ?",
    )
    .bind(&snapshot_json)
    .bind(id)
    .bind(user.id)
    .execute(&pool)
    .await?;

    Ok(Json(GradeResponse {
        results,
        score,
        correct_count,
        total_count,
    })
    .into_response())
}

/// Compare `user` against `truth`, returning 'correct' / 'close' / 'wrong'.
/// Both arguments are already trimmed and not empty (caller checks).
///
/// Rules:
/// - case-insensitive
/// - ignore trailing punctuation like `,` `.` `!` etc
/// - exact match → "correct"
/// - else Levenshtein distance ≤ tolerance(len) → "close"
/// - else → "wrong"
fn judge(user: &str, truth: &str) -> &'static str {
    let u = normalize(user);
    let t = normalize(truth);
    if u == t {
        return "correct";
    }
    let dist = strsim::levenshtein(&u, &t);
    let tol = if t.chars().count() <= 4 { 1 } else { 2 };
    if dist <= tol {
        "close"
    } else {
        "wrong"
    }
}

fn normalize(s: &str) -> String {
    s.trim_matches(|c: char| c.is_ascii_punctuation())
        .to_lowercase()
}

#[derive(Debug, Deserialize)]
struct GenerateLlmOutput {
    #[serde(default)]
    simplified_text: String,
    #[serde(default)]
    blanks: Vec<RawBlank>,
}

#[derive(Debug, Deserialize)]
struct RawBlank {
    #[serde(default)]
    answer: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    hint: Option<String>,
    #[serde(default)]
    explanation_zh: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn judge_exact_match() {
        assert_eq!(judge("turned down", "turned down"), "correct");
        assert_eq!(judge("Turned Down", "turned down"), "correct");
        assert_eq!(judge("turned down,", "turned down"), "correct");
    }

    #[test]
    fn judge_typo_is_close() {
        assert_eq!(judge("turnd down", "turned down"), "close");
        assert_eq!(judge("urge", "urged"), "close");
    }

    #[test]
    fn judge_wrong_answer() {
        assert_eq!(judge("accepted", "turned down"), "wrong");
    }

    #[test]
    fn validate_rejects_missing_placeholder() {
        let raw = GenerateLlmOutput {
            simplified_text: "He {{0}} the offer.".into(),
            blanks: vec![
                RawBlank {
                    answer: "turned down".into(),
                    category: "phrase".into(),
                    hint: None,
                    explanation_zh: "拒绝".into(),
                },
                RawBlank {
                    answer: "urged".into(),
                    category: "word".into(),
                    hint: None,
                    explanation_zh: "力劝".into(),
                },
            ],
        };
        let err = validate_and_clean(raw).unwrap_err().to_string();
        assert!(err.contains("blank #1 has no placeholder"));
    }

    #[test]
    fn validate_rejects_out_of_range_placeholder() {
        let raw = GenerateLlmOutput {
            simplified_text: "He {{0}} and {{5}}.".into(),
            blanks: vec![
                RawBlank {
                    answer: "a".into(),
                    category: "word".into(),
                    hint: None,
                    explanation_zh: "x".into(),
                },
                RawBlank {
                    answer: "b".into(),
                    category: "word".into(),
                    hint: None,
                    explanation_zh: "y".into(),
                },
            ],
        };
        let err = validate_and_clean(raw).unwrap_err().to_string();
        assert!(err.contains("out of range"));
    }

    #[test]
    fn validate_accepts_well_formed_input() {
        let raw = GenerateLlmOutput {
            simplified_text: "He {{0}} and {{1}}.".into(),
            blanks: vec![
                RawBlank {
                    answer: "a".into(),
                    category: "word".into(),
                    hint: None,
                    explanation_zh: "x".into(),
                },
                RawBlank {
                    answer: "b".into(),
                    category: "phrase".into(),
                    hint: Some("hint".into()),
                    explanation_zh: "y".into(),
                },
            ],
        };
        let cleaned = validate_and_clean(raw).unwrap();
        assert_eq!(cleaned.blanks.len(), 2);
        assert_eq!(cleaned.blanks[1].category, "phrase");
    }
}
