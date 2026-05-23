//! "Quick notes" — a sentence the user saw somewhere outside the app, captured
//! with an LLM-generated translation + analysis (key expressions + grammar).
//!
//! - POST   /api/quick-notes        — analyze with LLM, save, return saved row
//! - GET    /api/quick-notes        — list current user's notes, newest first
//! - DELETE /api/quick-notes/:id    — delete one (only the owner can)
//!
//! User isolation is enforced via `WHERE user_id = ?` on every query.

use anyhow::Context;
use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, post};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::SqlitePool;

use crate::auth::CurrentUser;
use crate::config::SharedLlm;
use crate::error::{AppError, Result};
use crate::language::Language;

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/quick-notes", post(create).get(list))
        .route("/quick-notes/:id", delete(remove).patch(update))
}

#[derive(Debug, Deserialize)]
pub struct CreateReq {
    pub text: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Highlight {
    pub phrase: String,
    pub meaning_zh: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub usage_note: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GrammarPoint {
    pub point: String,
    pub explanation_zh: String,
}

#[derive(Debug, Serialize)]
pub struct QuickNote {
    pub id: i64,
    pub text: String,
    pub language: String,
    pub translation_zh: String,
    pub highlights: Vec<Highlight>,
    pub grammar: Vec<GrammarPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub created_at: String,
}

#[derive(Debug, sqlx::FromRow)]
struct Row {
    id: i64,
    text: String,
    language: String,
    translation_zh: String,
    highlights_json: String,
    grammar_json: String,
    source: Option<String>,
    created_at: String,
}

impl Row {
    fn into_note(self) -> QuickNote {
        QuickNote {
            id: self.id,
            text: self.text,
            language: self.language,
            translation_zh: self.translation_zh,
            highlights: serde_json::from_str(&self.highlights_json).unwrap_or_default(),
            grammar: serde_json::from_str(&self.grammar_json).unwrap_or_default(),
            source: self.source,
            created_at: self.created_at,
        }
    }
}

async fn create(
    State(pool): State<SqlitePool>,
    State(http): State<reqwest::Client>,
    State(llm): State<SharedLlm>,
    user: CurrentUser,
    Json(req): Json<CreateReq>,
) -> Result<Response> {
    let text = req.text.trim();
    if text.is_empty() {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "text is required" })),
        )
            .into_response());
    }
    if text.chars().count() > 4000 {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "text too long (max 4000 chars)" })),
        )
            .into_response());
    }
    let language = Language::from_code(req.language.as_deref().unwrap_or("en"));
    let source = req
        .source
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let analysis = analyze(&http, &llm, language, text).await?;

    let highlights_json = serde_json::to_string(&analysis.highlights)?;
    let grammar_json = serde_json::to_string(&analysis.grammar)?;

    let row: Row = sqlx::query_as(
        "INSERT INTO quick_notes \
           (user_id, text, language, translation_zh, highlights_json, grammar_json, source) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         RETURNING id, text, language, translation_zh, highlights_json, grammar_json, source, created_at",
    )
    .bind(user.id)
    .bind(text)
    .bind(language.code())
    .bind(&analysis.translation_zh)
    .bind(&highlights_json)
    .bind(&grammar_json)
    .bind(source.as_deref())
    .fetch_one(&pool)
    .await?;

    Ok(Json(row.into_note()).into_response())
}

async fn list(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
) -> Result<Json<Vec<QuickNote>>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, text, language, translation_zh, highlights_json, grammar_json, source, created_at \
         FROM quick_notes \
         WHERE user_id = ? \
         ORDER BY created_at DESC \
         LIMIT 500",
    )
    .bind(user.id)
    .fetch_all(&pool)
    .await?;

    Ok(Json(rows.into_iter().map(Row::into_note).collect()))
}

async fn remove(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode> {
    let result = sqlx::query("DELETE FROM quick_notes WHERE id = ? AND user_id = ?")
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
pub struct UpdateReq {
    /// Only fields present in the JSON are updated; absent fields are left alone.
    #[serde(default)]
    pub translation_zh: Option<String>,
    #[serde(default)]
    pub highlights: Option<Vec<Highlight>>,
    #[serde(default)]
    pub grammar: Option<Vec<GrammarPoint>>,
    #[serde(default)]
    pub source: Option<Option<String>>,
}

async fn update(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(req): Json<UpdateReq>,
) -> Result<Response> {
    let existing: Option<Row> = sqlx::query_as(
        "SELECT id, text, language, translation_zh, highlights_json, grammar_json, source, created_at \
         FROM quick_notes WHERE id = ? AND user_id = ?",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&pool)
    .await?;

    let Some(existing) = existing else {
        return Ok((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "quick note not found" })),
        )
            .into_response());
    };

    let translation_zh = req
        .translation_zh
        .map(|s| s.trim().to_string())
        .unwrap_or(existing.translation_zh);

    let highlights_json = match req.highlights {
        Some(items) => {
            let cleaned: Vec<Highlight> = items
                .into_iter()
                .filter(|h| !h.phrase.trim().is_empty() && !h.meaning_zh.trim().is_empty())
                .map(|h| Highlight {
                    phrase: h.phrase.trim().to_string(),
                    meaning_zh: h.meaning_zh.trim().to_string(),
                    usage_note: h
                        .usage_note
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty()),
                })
                .collect();
            serde_json::to_string(&cleaned)?
        }
        None => existing.highlights_json,
    };

    let grammar_json = match req.grammar {
        Some(items) => {
            let cleaned: Vec<GrammarPoint> = items
                .into_iter()
                .filter(|g| !g.point.trim().is_empty() && !g.explanation_zh.trim().is_empty())
                .map(|g| GrammarPoint {
                    point: g.point.trim().to_string(),
                    explanation_zh: g.explanation_zh.trim().to_string(),
                })
                .collect();
            serde_json::to_string(&cleaned)?
        }
        None => existing.grammar_json,
    };

    let source = match req.source {
        Some(value) => value
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        None => existing.source,
    };

    let row: Row = sqlx::query_as(
        "UPDATE quick_notes \
            SET translation_zh = ?, highlights_json = ?, grammar_json = ?, source = ? \
            WHERE id = ? AND user_id = ? \
            RETURNING id, text, language, translation_zh, highlights_json, grammar_json, source, created_at",
    )
    .bind(translation_zh)
    .bind(highlights_json)
    .bind(grammar_json)
    .bind(source)
    .bind(id)
    .bind(user.id)
    .fetch_one(&pool)
    .await?;

    Ok(Json(row.into_note()).into_response())
}

struct Analysis {
    translation_zh: String,
    highlights: Vec<Highlight>,
    grammar: Vec<GrammarPoint>,
}

async fn analyze(
    http: &reqwest::Client,
    llm: &SharedLlm,
    language: Language,
    text: &str,
) -> Result<Analysis> {
    let cfg = llm.read().await.clone();
    if !cfg.configured() {
        return Err(AppError(anyhow::anyhow!(
            "DeepSeek API key not configured; set it on the Settings page"
        )));
    }
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": language.quick_note_system_prompt() },
            { "role": "user",   "content": language.quick_note_user_prompt(text) },
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.3
    });

    let res = http
        .post(&url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
        .context("DeepSeek request")?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        let trimmed: String = body.chars().take(300).collect();
        return Err(AppError(anyhow::anyhow!("DeepSeek {status}: {trimmed}")));
    }

    let raw: serde_json::Value = res.json().await.context("DeepSeek json envelope")?;
    let content = raw
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|s| s.as_str())
        .ok_or_else(|| AppError(anyhow::anyhow!("DeepSeek response missing message.content")))?;

    parse_analysis(content)
        .with_context(|| format!("parse DeepSeek analysis: {content}"))
        .map_err(AppError)
}

fn parse_analysis(content: &str) -> anyhow::Result<Analysis> {
    #[derive(Deserialize)]
    struct Raw {
        #[serde(default)]
        translation_zh: String,
        #[serde(default)]
        highlights: Vec<RawHighlight>,
        #[serde(default)]
        grammar: Vec<RawGrammar>,
    }
    #[derive(Deserialize)]
    struct RawHighlight {
        #[serde(default)]
        phrase: String,
        #[serde(default)]
        meaning_zh: String,
        #[serde(default)]
        usage_note: Option<String>,
    }
    #[derive(Deserialize)]
    struct RawGrammar {
        #[serde(default)]
        point: String,
        #[serde(default)]
        explanation_zh: String,
    }

    let raw: Raw = serde_json::from_str(content)?;
    let highlights = raw
        .highlights
        .into_iter()
        .filter(|h| !h.phrase.trim().is_empty() && !h.meaning_zh.trim().is_empty())
        .map(|h| Highlight {
            phrase: h.phrase.trim().to_string(),
            meaning_zh: h.meaning_zh.trim().to_string(),
            usage_note: h
                .usage_note
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
        })
        .collect();
    let grammar = raw
        .grammar
        .into_iter()
        .filter(|g| !g.point.trim().is_empty() && !g.explanation_zh.trim().is_empty())
        .map(|g| GrammarPoint {
            point: g.point.trim().to_string(),
            explanation_zh: g.explanation_zh.trim().to_string(),
        })
        .collect();

    Ok(Analysis {
        translation_zh: raw.translation_zh.trim().to_string(),
        highlights,
        grammar,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_analysis;

    #[test]
    fn parses_full_response() {
        let content = r#"{
            "translation_zh": "我决定不参加会议。",
            "highlights": [
                {"phrase":"opt out of","meaning_zh":"选择不参加","usage_note":"opt out of + 名词"},
                {"phrase":"call it a day","meaning_zh":"今天到此为止"}
            ],
            "grammar": [
                {"point":"动名词作宾语","explanation_zh":"opt 后面接 to V 或 out of + 名词/动名词"}
            ]
        }"#;
        let a = parse_analysis(content).unwrap();
        assert_eq!(a.translation_zh, "我决定不参加会议。");
        assert_eq!(a.highlights.len(), 2);
        assert!(a.highlights[1].usage_note.is_none());
        assert_eq!(a.grammar.len(), 1);
    }

    #[test]
    fn drops_empty_entries() {
        let content = r#"{
            "translation_zh": "x",
            "highlights": [
                {"phrase":"","meaning_zh":"y"},
                {"phrase":"a","meaning_zh":""},
                {"phrase":"b","meaning_zh":"c"}
            ],
            "grammar": []
        }"#;
        let a = parse_analysis(content).unwrap();
        assert_eq!(a.highlights.len(), 1);
        assert_eq!(a.highlights[0].phrase, "b");
        assert_eq!(a.grammar.len(), 0);
    }

    #[test]
    fn tolerates_missing_fields() {
        let a = parse_analysis(r#"{"translation_zh":"only this"}"#).unwrap();
        assert_eq!(a.translation_zh, "only this");
        assert_eq!(a.highlights.len(), 0);
        assert_eq!(a.grammar.len(), 0);
    }
}
