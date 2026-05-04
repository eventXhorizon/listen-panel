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
pub struct LookupResp {
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

async fn lookup(
    State(http): State<reqwest::Client>,
    State(llm): State<SharedLlm>,
    _user: CurrentUser,
    Json(req): Json<LookupReq>,
) -> Result<Json<LookupResp>> {
    let cfg = llm.read().await.clone();
    if !cfg.configured() {
        return Err(AppError(anyhow::anyhow!(
            "DeepSeek API key not configured; set it on the Settings page"
        )));
    }

    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let language = req
        .language
        .as_deref()
        .map(Language::from_code)
        .unwrap_or(Language::English);

    let body = json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": language.lookup_system_prompt() },
            { "role": "user", "content": language.lookup_user_prompt(&req.word, &req.context) }
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
        .map_err(anyhow::Error::from)?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        let trimmed: String = text.chars().take(200).collect();
        return Err(AppError(anyhow::anyhow!(
            "DeepSeek API {status}: {trimmed}"
        )));
    }

    let raw: serde_json::Value = res.json().await.map_err(anyhow::Error::from)?;
    let content = raw
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|s| s.as_str())
        .ok_or_else(|| anyhow::anyhow!("DeepSeek response missing message.content"))?;

    let parsed: LookupResp = serde_json::from_str(content)
        .map_err(|e| anyhow::anyhow!("DeepSeek returned invalid JSON: {e}"))?;

    if parsed.definition_zh.is_empty() {
        return Err(AppError(anyhow::anyhow!(
            "DeepSeek response missing definition_zh"
        )));
    }
    Ok(Json(parsed))
}
