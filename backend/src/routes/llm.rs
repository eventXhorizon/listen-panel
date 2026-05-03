use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::routing::post;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::config::SharedLlm;
use crate::error::{AppError, Result};

pub fn router() -> Router<crate::AppState> {
    Router::new().route("/lookup", post(lookup))
}

const SYSTEM_PROMPT: &str = "你是英语词汇学习助手。给定一个英语词或短语,以及它所在的英文句子,返回 JSON,字段如下:\n\
{\n\
  \"lemma\": \"原形(动词原形 / 名词单数 / 短语规范形式)\",\n\
  \"phonetic\": \"IPA 美音音标,如 /ˈrʌn/\",\n\
  \"pos\": \"词性缩写,如 n. v. adj. adv. phrase\",\n\
  \"definition_zh\": \"在该上下文中的简洁中文释义,1-2 句\",\n\
  \"definition_en\": \"简洁英文释义,1 句\",\n\
  \"example_zh\": \"原句的中文翻译\"\n\
}\n\
只返回 JSON,不要 markdown 代码块,不要解释。";

#[derive(Debug, Deserialize)]
pub struct LookupReq {
    pub word: String,
    pub context: String,
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
    Json(req): Json<LookupReq>,
) -> Result<Json<LookupResp>> {
    let cfg = llm.read().await.clone();
    if !cfg.configured() {
        return Err(AppError(anyhow::anyhow!(
            "DeepSeek API key not configured; set it on the Settings page"
        )));
    }

    let url = format!(
        "{}/chat/completions",
        cfg.base_url.trim_end_matches('/')
    );

    let body = json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": format!("word: \"{}\"\ncontext: \"{}\"", req.word, req.context) }
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
