use std::path::PathBuf;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tokio::fs;

use crate::auth::CurrentUser;
use crate::config::{SharedTts, TtsProvider};
use crate::error::Result;
use crate::language::Language;

pub fn router() -> Router<crate::AppState> {
    Router::new().route("/tts/speech", axum::routing::post(speech))
}

pub async fn ensure_cache_dir() -> std::io::Result<()> {
    fs::create_dir_all(crate::paths::tts_cache_dir()).await
}

#[derive(Debug, Deserialize)]
struct SpeechRequest {
    text: String,
    #[serde(default)]
    material_id: Option<i64>,
    /// Anchor an essay paragraph instead of a material — used by the model-
    /// essays detail page so cache shards per-essay just like per-material.
    /// Specify either material_id or essay_id, not both.
    #[serde(default)]
    essay_id: Option<i64>,
    #[serde(default)]
    language: Option<String>,
}

/// Hard cap on a single TTS request. Word lookups sit far under this;
/// essay paragraphs occasionally run long (PG essays in particular).
/// Azure caps SSML synthesis at ~10 minutes / request, which works out
/// to roughly 4-5k chars at conversational pace — pick 4000 to stay
/// comfortably under that.
const MAX_TTS_CHARS: usize = 4000;

/// Azure's synthesis call scales with input length. A 4000-char request
/// can spend 20-40 seconds on the server side; the shared `state.http`
/// client uses a 20s timeout that's sized for snappy word lookups, not
/// paragraph synthesis. Past 20s reqwest aborts the body read and
/// returns the misleading "operation timed out / decoding response body"
/// error. Build a dedicated client for the Azure call. Same pattern as
/// routes/essays.rs and study.rs.
const AZURE_TIMEOUT_SECS: u64 = 180;

fn build_azure_http() -> std::io::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(AZURE_TIMEOUT_SECS))
        .build()
        .map_err(|e| std::io::Error::other(format!("build azure http client: {e}")))
}

async fn speech(
    State(_http): State<reqwest::Client>,
    State(tts): State<SharedTts>,
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Json(req): Json<SpeechRequest>,
) -> Result<Response> {
    // Use a dedicated long-timeout client for the Azure round trip;
    // the shared http client's 20s timeout is too tight for paragraph-
    // length synthesis.
    let http = build_azure_http()?;
    let text = req.text.trim();
    if text.is_empty() {
        return Ok((StatusCode::BAD_REQUEST, "text is required").into_response());
    }
    if text.chars().count() > MAX_TTS_CHARS {
        return Ok((StatusCode::BAD_REQUEST, "text is too long").into_response());
    }
    if req.material_id.is_some() && req.essay_id.is_some() {
        return Ok((
            StatusCode::BAD_REQUEST,
            "specify either material_id or essay_id, not both",
        )
            .into_response());
    }

    // Resolve the anchor: either a material or an essay, with the source's
    // language locked in. Both go through the same `Anchor` enum so the
    // cache path layout shards consistently.
    let mut source_language: Option<String> = None;
    let anchor = match (req.material_id, req.essay_id) {
        (Some(id), None) if id > 0 => {
            let row: Option<(String,)> =
                sqlx::query_as("SELECT language FROM materials WHERE id = ? AND user_id = ?")
                    .bind(id)
                    .bind(user.id)
                    .fetch_optional(&pool)
                    .await?;
            let Some((language,)) = row else {
                return Ok((StatusCode::NOT_FOUND, "material not found").into_response());
            };
            source_language = Some(language);
            Anchor::Material(id)
        }
        (None, Some(id)) if id > 0 => {
            let row: Option<(String,)> = sqlx::query_as(
                "SELECT language FROM model_essays WHERE id = ? AND user_id = ?",
            )
            .bind(id)
            .bind(user.id)
            .fetch_optional(&pool)
            .await?;
            let Some((language,)) = row else {
                return Ok((StatusCode::NOT_FOUND, "essay not found").into_response());
            };
            source_language = Some(language);
            Anchor::Essay(id)
        }
        (Some(_), _) | (_, Some(_)) => {
            return Ok((StatusCode::BAD_REQUEST, "id is invalid").into_response());
        }
        (None, None) => Anchor::None,
    };

    let cfg = tts.read().await.clone();
    if !cfg.configured() {
        return Ok((StatusCode::SERVICE_UNAVAILABLE, "tts not configured").into_response());
    }
    let language = req.language.as_deref();
    let language = source_language
        .as_deref()
        .or(language)
        .map(Language::normalize)
        .unwrap_or(Language::English.code());

    match cfg.provider {
        TtsProvider::Azure => cached_azure_speech(&http, &cfg, text, anchor, language).await,
    }
}

/// What the cached output is keyed to. Each variant gets its own
/// subdirectory under the TTS cache root so the file names can't
/// collide across material-1 and essay-1.
#[derive(Debug, Clone, Copy)]
enum Anchor {
    None,
    Material(i64),
    Essay(i64),
}

async fn cached_azure_speech(
    http: &reqwest::Client,
    cfg: &crate::config::TtsConfig,
    text: &str,
    anchor: Anchor,
    language: &str,
) -> Result<Response> {
    let cache_path = cache_path(cfg, text, anchor, language);
    match fs::read(&cache_path).await {
        Ok(bytes) => {
            tracing::debug!(path = %cache_path.display(), "tts cache hit");
            return Ok(audio_response(Bytes::from(bytes)));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            tracing::warn!(
                path = %cache_path.display(),
                "failed to read tts cache entry: {e}"
            );
        }
    }

    let bytes = match azure_speech(http, cfg, text, language).await? {
        Ok(bytes) => bytes,
        Err(response) => return Ok(response),
    };
    if let Err(e) = write_cache_entry(&cache_path, &bytes).await {
        tracing::warn!(
            path = %cache_path.display(),
            "failed to write tts cache entry: {e}"
        );
    }
    Ok(audio_response(bytes))
}

async fn azure_speech(
    http: &reqwest::Client,
    cfg: &crate::config::TtsConfig,
    text: &str,
    language: &str,
) -> Result<std::result::Result<Bytes, Response>> {
    let region = cfg.region.trim();
    if region.is_empty() {
        return Ok(Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Azure region not configured; set it on the Settings page",
        )
            .into_response()));
    }
    let url = format!("https://{region}.tts.speech.microsoft.com/cognitiveservices/v1");
    let voice = cfg.voice_for_language(language);
    let xml_lang = cfg.xml_lang_for(language);
    let ssml = format!(
        "<speak version='1.0' xml:lang='{xml_lang}'><voice name='{voice}'>{}</voice></speak>",
        escape_xml(text)
    );

    let res = http
        .post(&url)
        .header("Ocp-Apim-Subscription-Key", &cfg.api_key)
        .header("Content-Type", "application/ssml+xml")
        .header("X-Microsoft-OutputFormat", &cfg.output_format)
        .header("User-Agent", "listen-panel")
        .body(ssml)
        .send()
        .await?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        let msg = if body.trim().is_empty() {
            format!("Azure Speech returned {status}")
        } else {
            format!(
                "Azure Speech returned {status}: {}",
                body.chars().take(300).collect::<String>()
            )
        };
        tracing::warn!("{msg}");
        return Ok(Err((StatusCode::BAD_GATEWAY, msg).into_response()));
    }

    Ok(Ok(res.bytes().await?))
}

fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\'' => out.push_str("&apos;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

fn cache_path(
    cfg: &crate::config::TtsConfig,
    text: &str,
    anchor: Anchor,
    language: &str,
) -> PathBuf {
    let provider = tts_provider_name(cfg);
    let language = Language::normalize(language);
    let hash = cache_key_hash(cfg, text, language);
    let filename = format!(
        "{provider}_{language}_{}_{}.mp3",
        text_slug(text),
        hash.chars().take(16).collect::<String>()
    );
    cache_dir_for_anchor(anchor).join(filename)
}

fn cache_dir_for_anchor(anchor: Anchor) -> PathBuf {
    let root = crate::paths::tts_cache_dir();
    match anchor {
        Anchor::Material(id) => root.join(format!("material-{id}")),
        Anchor::Essay(id) => root.join(format!("essay-{id}")),
        Anchor::None => root,
    }
}

fn tts_provider_name(cfg: &crate::config::TtsConfig) -> &'static str {
    match cfg.provider {
        TtsProvider::Azure => "azure",
    }
}

fn cache_key_hash(cfg: &crate::config::TtsConfig, text: &str, language: &str) -> String {
    let lang = Language::normalize(language);
    let voice = cfg.voice_for_language(lang);
    let mut hasher = Sha256::new();
    for part in [
        tts_provider_name(cfg),
        cfg.region.as_str(),
        voice,
        cfg.output_format.as_str(),
        lang,
    ] {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    hasher.update(text.as_bytes());
    hasher.update([0]);
    format!("{:x}", hasher.finalize())
}

fn text_slug(text: &str) -> String {
    let mut slug = String::new();
    let mut last_was_sep = false;
    for ch in text.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || is_cjk_slug_char(ch) {
            if slug.len() >= 48 {
                break;
            }
            slug.push(ch);
            last_was_sep = false;
        } else if (ch.is_whitespace() || matches!(ch, '-' | '_' | '\'' | '.' | '/'))
            && !slug.is_empty()
            && !last_was_sep
            && slug.len() < 48
        {
            slug.push('-');
            last_was_sep = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "speech".to_string()
    } else {
        slug
    }
}

fn is_cjk_slug_char(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff
    )
}

async fn write_cache_entry(path: &PathBuf, bytes: &Bytes) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let tmp = path.with_extension("mp3.tmp");
    fs::write(&tmp, bytes).await?;
    fs::rename(&tmp, path).await?;
    Ok(())
}

fn audio_response(bytes: Bytes) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("audio/mpeg"));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    (headers, bytes).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_slug_keeps_readable_words() {
        assert_eq!(text_slug("spiritual drain"), "spiritual-drain");
        assert_eq!(text_slug("Don't give up!"), "don-t-give-up");
        assert_eq!(text_slug("こんにちは 世界"), "こんにちは-世界");
        assert_eq!(text_slug("   "), "speech");
    }

    #[test]
    fn cache_filename_includes_text_slug_and_short_hash() {
        let cfg = crate::config::TtsConfig::default();
        let path = cache_path(&cfg, "spiritual drain", Some(42), "en");
        let name = path.file_name().and_then(|v| v.to_str()).unwrap_or("");
        assert!(path.to_string_lossy().contains("material-42"));
        assert!(name.starts_with("azure_en_spiritual-drain_"));
        assert!(name.ends_with(".mp3"));
    }

    #[test]
    fn cache_filename_includes_japanese_language() {
        let cfg = crate::config::TtsConfig::default();
        let path = cache_path(&cfg, "こんにちは", Some(42), "ja");
        let name = path.file_name().and_then(|v| v.to_str()).unwrap_or("");
        assert!(name.starts_with("azure_ja_こんにちは_"));
    }
}
