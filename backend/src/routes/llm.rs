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
use crate::llm_call::{LlmProvider, call_chat_completions, call_fallback_only};

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/lookup", post(lookup))
        .route("/translate", post(translate))
        .route("/recognize", post(recognize))
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

/// Roughly 8 MB of base64 (~6 MB raw image). Gemini accepts larger inline
/// images, but this keeps request bodies and OCR latency bounded.
const MAX_IMAGE_DATA_URL_LEN: usize = 8 * 1024 * 1024;

const RECOGNIZE_SYSTEM_PROMPT: &str = "你是一个图片文字识别 + 翻译助手。用户会给你一张图片。请:\n\
    1. 识别(OCR)图片里所有的英文文字,保持原有的行/段落顺序\n\
    2. 把识别出的英文整体翻译成自然、通顺的简体中文\n\
    规则:\n\
    - 只识别英文文字;忽略纯装饰、水印、与正文无关的零碎角标\n\
    - source_text 用 \\n 保留换行与段落;translation_zh 也按对应段落用 \\n 分段\n\
    - 如果图片里没有可识别的英文文字,两个字段都返回空字符串\n\
    - 不要添加任何解释、不要 markdown 包裹\n\
    输出必须是严格 JSON: {\"source_text\":\"...\",\"translation_zh\":\"...\"}";

#[derive(Debug, Deserialize)]
pub struct RecognizeReq {
    /// A `data:image/...;base64,...` URL of the pasted/uploaded image.
    pub image: String,
}

#[derive(Debug, Deserialize)]
struct RecognizeCore {
    #[serde(default)]
    source_text: String,
    #[serde(default)]
    translation_zh: String,
}

#[derive(Debug, Serialize)]
pub struct RecognizeResp {
    pub source_text: String,
    pub translation_zh: String,
    pub provider: LlmProvider,
}

/// OCR an image and translate the recognized English into Chinese in a single
/// multimodal call. Routed straight to the fallback (Gemini) provider since the
/// text-only primary can't see images. Side-effect free — stores nothing.
async fn recognize(
    State(http): State<reqwest::Client>,
    State(llm): State<SharedLlm>,
    _user: CurrentUser,
    Json(req): Json<RecognizeReq>,
) -> Result<Json<RecognizeResp>> {
    let cfg = llm.read().await.clone();

    let image = req.image.trim();
    if !image.starts_with("data:image/") || !image.contains(";base64,") {
        return Err(AppError(anyhow::anyhow!(
            "image must be a data:image/...;base64 URL"
        )));
    }
    if image.len() > MAX_IMAGE_DATA_URL_LEN {
        return Err(AppError(anyhow::anyhow!("图片太大,请压缩后再试")));
    }

    let body = json!({
        "messages": [
            { "role": "system", "content": RECOGNIZE_SYSTEM_PROMPT },
            { "role": "user", "content": [
                { "type": "text", "text": "识别这张图片里的英文,并翻译成中文。" },
                { "type": "image_url", "image_url": { "url": image } }
            ] }
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.2
    });

    let outcome = call_fallback_only(&http, &cfg, body, "recognize")
        .await
        .map_err(AppError)?;

    let core: RecognizeCore = serde_json::from_str(&outcome.content)
        .map_err(|e| anyhow::anyhow!("LLM returned invalid JSON: {e}"))?;

    Ok(Json(RecognizeResp {
        source_text: core.source_text,
        translation_zh: core.translation_zh,
        provider: outcome.provider,
    }))
}
