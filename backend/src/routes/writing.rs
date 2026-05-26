//! Writing-practice route. Two LLM-backed actions plus a local pre-filter
//! ported from the better-phrase Claude Code hook:
//!
//!   POST   /api/writing/polish     — run detector, decide polish vs.
//!                                    translate vs. skip, call LLM if needed,
//!                                    persist if a real result came back
//!   GET    /api/writing/history    — list this user's recent submissions
//!                                    (most recent first, cap 100)
//!   DELETE /api/writing/history/:id — delete one row
//!
//! Inputs the local detector classifies as "skip" (pure code, single token,
//! Chinese-only with translation off, etc.) never reach the LLM and are not
//! stored — same zero-token-on-noise contract as the original hook.

use anyhow::Context;
use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::SqlitePool;

use crate::auth::CurrentUser;
use crate::config::SharedLlm;
use crate::error::{AppError, Result};
use crate::language;
use crate::llm_call::{LlmProvider, call_chat_completions};

mod detector;
pub use detector::{WritingAction, route_intent};

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/writing/polish", post(polish))
        .route("/writing/history", get(history))
        .route("/writing/history/:id", delete(remove))
}

const MAX_INPUT_CHARS: usize = 4000;

#[derive(Debug, Deserialize)]
pub struct PolishReq {
    pub text: String,
    /// Whether to translate Chinese-dominant input. Mirrors the better-phrase
    /// CLI toggle. Default true — the writing page exposes the switch in the UI.
    #[serde(default = "default_true")]
    pub translate_enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PolishTip {
    pub original: String,
    pub corrected: String,
    pub explanation_zh: String,
}

/// Discriminated by `action`. `polish` carries tips+rewrite; `translate`
/// carries translation; `skip` carries nothing and means "detector said this
/// input isn't worth running the LLM on" (no DB row was created either).
#[derive(Debug, Serialize)]
pub struct PolishResult {
    pub action: &'static str,
    /// DB id of the writing_drafts row. `None` when action == "skip".
    pub id: Option<i64>,
    pub original: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tips: Option<Vec<PolishTip>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rewrite: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
    /// Which provider answered, when an LLM call was made.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<LlmProvider>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Set on skip, explains why so the UI can show a hint instead of just
    /// dropping the request silently.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<&'static str>,
}

#[derive(Debug, sqlx::FromRow)]
struct Row {
    id: i64,
    original: String,
    mode: String,
    result_json: String,
    created_at: String,
}

/// JSON we persist as `result_json`. We keep tips/rewrite/translation here so
/// /history can replay any past polish without re-calling the LLM.
#[derive(Debug, Serialize, Deserialize)]
struct StoredResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    tips: Option<Vec<PolishTip>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rewrite: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    translation: Option<String>,
    provider: LlmProvider,
}

impl Row {
    fn into_result(self) -> PolishResult {
        let stored: StoredResult = serde_json::from_str(&self.result_json).unwrap_or(StoredResult {
            tips: None,
            rewrite: None,
            translation: None,
            provider: LlmProvider::Primary,
        });
        let action: &'static str = if self.mode == "translate" {
            "translate"
        } else {
            "polish"
        };
        PolishResult {
            action,
            id: Some(self.id),
            original: self.original,
            tips: stored.tips,
            rewrite: stored.rewrite,
            translation: stored.translation,
            provider: Some(stored.provider),
            created_at: Some(self.created_at),
            skip_reason: None,
        }
    }
}

async fn polish(
    State(pool): State<SqlitePool>,
    State(http): State<reqwest::Client>,
    State(llm): State<SharedLlm>,
    user: CurrentUser,
    Json(req): Json<PolishReq>,
) -> Result<Response> {
    let text = req.text.trim();
    if text.is_empty() {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "text is required" })),
        )
            .into_response());
    }
    if text.chars().count() > MAX_INPUT_CHARS {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("text too long (max {MAX_INPUT_CHARS} chars)") })),
        )
            .into_response());
    }

    let action = route_intent(text, req.translate_enabled);
    match action {
        WritingAction::Skip => Ok(Json(PolishResult {
            action: "skip",
            id: None,
            original: text.to_string(),
            tips: None,
            rewrite: None,
            translation: None,
            provider: None,
            created_at: None,
            skip_reason: Some("input is empty / code-only / too short, or Chinese with translation disabled"),
        })
        .into_response()),
        WritingAction::Polish => run_polish(pool, http, llm, user, text).await,
        WritingAction::Translate => run_translate(pool, http, llm, user, text).await,
    }
}

async fn run_polish(
    pool: SqlitePool,
    http: reqwest::Client,
    llm: SharedLlm,
    user: CurrentUser,
    text: &str,
) -> Result<Response> {
    let cfg = llm.read().await.clone();
    let body = json!({
        "messages": [
            { "role": "system", "content": language::writing_polish_system_prompt() },
            { "role": "user",   "content": language::writing_polish_user_prompt(text) },
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.3
    });
    let outcome = call_chat_completions(&http, &cfg, body, "writing-polish")
        .await
        .map_err(AppError)?;

    let parsed: PolishLlmOutput = serde_json::from_str(&outcome.content)
        .with_context(|| format!("parse writing-polish output: {}", outcome.content))
        .map_err(AppError)?;
    let tips: Vec<PolishTip> = parsed
        .tips
        .into_iter()
        .filter(|t| !t.original.trim().is_empty() && !t.corrected.trim().is_empty())
        .map(|t| PolishTip {
            original: t.original.trim().to_string(),
            corrected: t.corrected.trim().to_string(),
            explanation_zh: t.explanation_zh.trim().to_string(),
        })
        .collect();
    let rewrite = parsed.rewrite.trim().to_string();

    let stored = StoredResult {
        tips: Some(tips.clone()),
        rewrite: Some(rewrite.clone()),
        translation: None,
        provider: outcome.provider,
    };
    let result_json = serde_json::to_string(&stored)?;

    let row: Row = sqlx::query_as(
        "INSERT INTO writing_drafts (user_id, original, mode, result_json) \
         VALUES (?, ?, 'polish', ?) \
         RETURNING id, original, mode, result_json, created_at",
    )
    .bind(user.id)
    .bind(text)
    .bind(&result_json)
    .fetch_one(&pool)
    .await?;

    Ok(Json(PolishResult {
        action: "polish",
        id: Some(row.id),
        original: row.original,
        tips: Some(tips),
        rewrite: Some(rewrite),
        translation: None,
        provider: Some(outcome.provider),
        created_at: Some(row.created_at),
        skip_reason: None,
    })
    .into_response())
}

async fn run_translate(
    pool: SqlitePool,
    http: reqwest::Client,
    llm: SharedLlm,
    user: CurrentUser,
    text: &str,
) -> Result<Response> {
    let cfg = llm.read().await.clone();
    let body = json!({
        "messages": [
            { "role": "system", "content": language::writing_translate_system_prompt() },
            { "role": "user",   "content": language::writing_translate_user_prompt(text) },
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.3
    });
    let outcome = call_chat_completions(&http, &cfg, body, "writing-translate")
        .await
        .map_err(AppError)?;

    let parsed: TranslateLlmOutput = serde_json::from_str(&outcome.content)
        .with_context(|| format!("parse writing-translate output: {}", outcome.content))
        .map_err(AppError)?;
    let translation = parsed.translation.trim().to_string();
    if translation.is_empty() {
        return Err(AppError(anyhow::anyhow!(
            "LLM returned empty translation"
        )));
    }

    let stored = StoredResult {
        tips: None,
        rewrite: None,
        translation: Some(translation.clone()),
        provider: outcome.provider,
    };
    let result_json = serde_json::to_string(&stored)?;

    let row: Row = sqlx::query_as(
        "INSERT INTO writing_drafts (user_id, original, mode, result_json) \
         VALUES (?, ?, 'translate', ?) \
         RETURNING id, original, mode, result_json, created_at",
    )
    .bind(user.id)
    .bind(text)
    .bind(&result_json)
    .fetch_one(&pool)
    .await?;

    Ok(Json(PolishResult {
        action: "translate",
        id: Some(row.id),
        original: row.original,
        tips: None,
        rewrite: None,
        translation: Some(translation),
        provider: Some(outcome.provider),
        created_at: Some(row.created_at),
        skip_reason: None,
    })
    .into_response())
}

async fn history(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
) -> Result<Json<Vec<PolishResult>>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, original, mode, result_json, created_at \
         FROM writing_drafts \
         WHERE user_id = ? \
         ORDER BY created_at DESC \
         LIMIT 100",
    )
    .bind(user.id)
    .fetch_all(&pool)
    .await?;
    Ok(Json(rows.into_iter().map(Row::into_result).collect()))
}

async fn remove(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode> {
    let result = sqlx::query("DELETE FROM writing_drafts WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&pool)
        .await?;
    if result.rows_affected() == 0 {
        return Ok(StatusCode::NOT_FOUND);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct PolishLlmOutput {
    #[serde(default)]
    tips: Vec<RawTip>,
    #[serde(default)]
    rewrite: String,
}

#[derive(Debug, Deserialize)]
struct RawTip {
    #[serde(default)]
    original: String,
    #[serde(default)]
    corrected: String,
    #[serde(default)]
    explanation_zh: String,
}

#[derive(Debug, Deserialize)]
struct TranslateLlmOutput {
    #[serde(default)]
    translation: String,
}
