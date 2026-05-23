use std::path::PathBuf;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
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
    #[serde(default)]
    language: Option<String>,
}

#[derive(Debug, Serialize)]
struct ElevenLabsRequest<'a> {
    text: &'a str,
    model_id: &'a str,
}

async fn speech(
    State(http): State<reqwest::Client>,
    State(tts): State<SharedTts>,
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Json(req): Json<SpeechRequest>,
) -> Result<Response> {
    let text = req.text.trim();
    if text.is_empty() {
        return Ok((StatusCode::BAD_REQUEST, "text is required").into_response());
    }
    if text.chars().count() > 500 {
        return Ok((StatusCode::BAD_REQUEST, "text is too long").into_response());
    }
    let mut material_language: Option<String> = None;
    let material_id = match req.material_id {
        Some(id) if id > 0 => {
            let row: Option<(String,)> =
                sqlx::query_as("SELECT language FROM materials WHERE id = ? AND user_id = ?")
                    .bind(id)
                    .bind(user.id)
                    .fetch_optional(&pool)
                    .await?;
            let Some((language,)) = row else {
                return Ok((StatusCode::NOT_FOUND, "material not found").into_response());
            };
            material_language = Some(language);
            Some(id)
        }
        Some(_) => {
            return Ok((StatusCode::BAD_REQUEST, "material_id is invalid").into_response());
        }
        None => None,
    };

    let cfg = tts.read().await.clone();
    if !cfg.configured() {
        return Ok((StatusCode::SERVICE_UNAVAILABLE, "tts not configured").into_response());
    }
    let language = req.language.as_deref();
    let language = material_language
        .as_deref()
        .or(language)
        .map(Language::normalize)
        .unwrap_or(Language::English.code());

    match cfg.provider {
        TtsProvider::ElevenLabs => {
            cached_elevenlabs_speech(&http, &cfg, text, material_id, language).await
        }
    }
}

async fn cached_elevenlabs_speech(
    http: &reqwest::Client,
    cfg: &crate::config::TtsConfig,
    text: &str,
    material_id: Option<i64>,
    language: &str,
) -> Result<Response> {
    let cache_path = cache_path(cfg, text, material_id, language);
    let legacy_cache_path = if language == Language::English.code() {
        Some(legacy_cache_path(cfg, text, material_id))
    } else {
        None
    };
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
    if let Some(legacy_cache_path) = legacy_cache_path.filter(|path| path != &cache_path) {
        match fs::read(&legacy_cache_path).await {
            Ok(bytes) => {
                tracing::debug!(path = %legacy_cache_path.display(), "tts legacy cache hit");
                return Ok(audio_response(Bytes::from(bytes)));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                tracing::warn!(
                    path = %legacy_cache_path.display(),
                    "failed to read legacy tts cache entry: {e}"
                );
            }
        }
    }

    let bytes = match elevenlabs_speech(http, cfg, text, language).await? {
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

async fn elevenlabs_speech(
    http: &reqwest::Client,
    cfg: &crate::config::TtsConfig,
    text: &str,
    language: &str,
) -> Result<std::result::Result<Bytes, Response>> {
    let base_url = cfg.base_url.trim_end_matches('/');
    let voice_id = cfg.voice_for_language(language);
    let url = format!(
        "{base_url}/v1/text-to-speech/{}?output_format={}",
        voice_id, cfg.output_format
    );
    let res = http
        .post(url)
        .header("xi-api-key", &cfg.api_key)
        .json(&ElevenLabsRequest {
            text,
            model_id: &cfg.model,
        })
        .send()
        .await?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        let msg = if body.trim().is_empty() {
            format!("ElevenLabs returned {status}")
        } else {
            format!(
                "ElevenLabs returned {status}: {}",
                body.chars().take(300).collect::<String>()
            )
        };
        tracing::warn!("{msg}");
        return Ok(Err((StatusCode::BAD_GATEWAY, msg).into_response()));
    }

    Ok(Ok(res.bytes().await?))
}

fn cache_path(
    cfg: &crate::config::TtsConfig,
    text: &str,
    material_id: Option<i64>,
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
    cache_dir_for_material(material_id).join(filename)
}

fn legacy_cache_path(
    cfg: &crate::config::TtsConfig,
    text: &str,
    material_id: Option<i64>,
) -> PathBuf {
    let provider = tts_provider_name(cfg);
    let hash = legacy_cache_key_hash(cfg, text);
    let filename = format!("{provider}_{hash}.mp3");
    cache_dir_for_material(material_id).join(filename)
}

fn cache_dir_for_material(material_id: Option<i64>) -> PathBuf {
    match material_id {
        Some(id) => crate::paths::tts_cache_dir().join(format!("material-{id}")),
        None => crate::paths::tts_cache_dir(),
    }
}

fn tts_provider_name(cfg: &crate::config::TtsConfig) -> &'static str {
    match cfg.provider {
        TtsProvider::ElevenLabs => "eleven_labs",
    }
}

fn cache_key_hash(cfg: &crate::config::TtsConfig, text: &str, language: &str) -> String {
    hash_cache_parts(cfg, text, Some(Language::normalize(language)))
}

fn legacy_cache_key_hash(cfg: &crate::config::TtsConfig, text: &str) -> String {
    hash_cache_parts(cfg, text, None)
}

fn hash_cache_parts(cfg: &crate::config::TtsConfig, text: &str, language: Option<&str>) -> String {
    let provider = match cfg.provider {
        TtsProvider::ElevenLabs => "eleven_labs",
    };
    // Use the language-aware voice so EN and JA outputs of the same text cache
    // to different files. The legacy path (language=None) falls back to the
    // historical voice_id field for cache-key continuity.
    let voice = match language {
        Some(lang) => cfg.voice_for_language(lang),
        None => cfg.voice_id.as_str(),
    };
    let mut hasher = Sha256::new();
    for part in [
        provider,
        cfg.base_url.trim_end_matches('/'),
        voice,
        cfg.model.as_str(),
        cfg.output_format.as_str(),
    ] {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    if let Some(language) = language {
        hasher.update(language.as_bytes());
        hasher.update([0]);
    }
    hasher.update(text.as_bytes());
    hasher.update([0]);
    let hash = hasher.finalize();
    format!("{hash:x}")
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
        assert!(name.starts_with("eleven_labs_en_spiritual-drain_"));
        assert!(name.ends_with(".mp3"));

        let legacy = legacy_cache_path(&cfg, "spiritual drain", Some(42));
        let legacy_name = legacy.file_name().and_then(|v| v.to_str()).unwrap_or("");
        assert!(legacy_name.starts_with("eleven_labs_"));
        assert!(!legacy_name.contains("spiritual-drain"));
    }

    #[test]
    fn cache_filename_includes_japanese_language() {
        let cfg = crate::config::TtsConfig::default();
        let path = cache_path(&cfg, "こんにちは", Some(42), "ja");
        let name = path.file_name().and_then(|v| v.to_str()).unwrap_or("");
        assert!(name.starts_with("eleven_labs_ja_こんにちは_"));
    }
}
