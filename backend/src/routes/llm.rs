use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::routing::post;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::CurrentUser;
use crate::config::SharedLlm;
use crate::error::{AppError, Result};
use crate::language::Language;
use crate::llm_call::{LlmProvider, call_chat_completions};

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/lookup", post(lookup))
        .route("/translate", post(translate))
}

#[derive(Debug, Deserialize)]
pub struct LookupReq {
    pub word: String,
    pub context: String,
    #[serde(default)]
    pub language: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LookupCore {
    pub lemma: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phonetic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
    pub definition_zh: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition_en: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example_zh: Option<String>,
}

/// Wire format: lookup fields + which provider answered. Provider tag is
/// surfaced in the UI so the user can see when DeepSeek is down and they're
/// reading fallback output.
#[derive(Debug, Serialize)]
pub struct LookupResp {
    #[serde(flatten)]
    pub core: LookupCore,
    pub provider: LlmProvider,
}

async fn lookup(
    State(http): State<reqwest::Client>,
    State(llm): State<SharedLlm>,
    _user: CurrentUser,
    Json(req): Json<LookupReq>,
) -> Result<Json<LookupResp>> {
    let cfg = llm.read().await.clone();
    if !cfg.configured() {
        return Err(AppError(anyhow::anyhow!(
            "LLM API key not configured; set it on the Settings page"
        )));
    }

    let language = req
        .language
        .as_deref()
        .map(Language::from_code)
        .unwrap_or(Language::English);

    let body = json!({
        "messages": [
            { "role": "system", "content": language.lookup_system_prompt() },
            { "role": "user", "content": language.lookup_user_prompt(&req.word, &req.context) }
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.3
    });

    let outcome = call_chat_completions(&http, &cfg, body, "lookup")
        .await
        .map_err(AppError)?;

    let core: LookupCore = serde_json::from_str(&outcome.content)
        .map_err(|e| anyhow::anyhow!("LLM returned invalid JSON: {e}"))?;

    if core.definition_zh.is_empty() {
        return Err(AppError(anyhow::anyhow!(
            "LLM response missing definition_zh"
        )));
    }
    Ok(Json(LookupResp {
        core,
        provider: outcome.provider,
    }))
}

#[derive(Debug, Deserialize)]
pub struct TranslateReq {
    pub text: String,
    #[serde(default)]
    pub language: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TranslateCore {
    translation_zh: String,
}

#[derive(Debug, Serialize)]
pub struct TranslateResp {
    pub translation_zh: String,
    pub provider: LlmProvider,
}

/// Paragraph-aware Chinese translation of arbitrary source text (a word, a
/// sentence, or several paragraphs). Side-effect free — unlike quick-notes it
/// stores nothing, so the TTS page can translate freely.
async fn translate(
    State(http): State<reqwest::Client>,
    State(llm): State<SharedLlm>,
    _user: CurrentUser,
    Json(req): Json<TranslateReq>,
) -> Result<Json<TranslateResp>> {
    let cfg = llm.read().await.clone();
    if !cfg.configured() {
        return Err(AppError(anyhow::anyhow!(
            "LLM API key not configured; set it on the Settings page"
        )));
    }

    let text = req.text.trim();
    if text.is_empty() {
        return Err(AppError(anyhow::anyhow!("text is required")));
    }
    if text.chars().count() > 4000 {
        return Err(AppError(anyhow::anyhow!("text is too long")));
    }

    let language = req
        .language
        .as_deref()
        .map(Language::from_code)
        .unwrap_or(Language::English);

    let body = json!({
        "messages": [
            { "role": "system", "content": language.translate_system_prompt() },
            { "role": "user", "content": language.translate_user_prompt(text) }
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.2
    });

    let outcome = call_chat_completions(&http, &cfg, body, "translate")
        .await
        .map_err(AppError)?;

    let core: TranslateCore = serde_json::from_str(&outcome.content)
        .map_err(|e| anyhow::anyhow!("LLM returned invalid JSON: {e}"))?;

    if core.translation_zh.trim().is_empty() {
        return Err(AppError(anyhow::anyhow!(
            "LLM response missing translation_zh"
        )));
    }
    Ok(Json(TranslateResp {
        translation_zh: core.translation_zh,
        provider: outcome.provider,
    }))
}
