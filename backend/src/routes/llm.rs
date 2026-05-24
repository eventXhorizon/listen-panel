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
    Router::new().route("/lookup", post(lookup))
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
