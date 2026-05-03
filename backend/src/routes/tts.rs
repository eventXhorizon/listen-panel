use std::path::PathBuf;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::fs;

use crate::auth::CurrentUser;
use crate::config::{SharedTts, TtsProvider};
use crate::error::Result;

const CACHE_DIR: &str = "data/tts-cache";

pub fn router() -> Router<crate::AppState> {
    Router::new().route("/tts/speech", axum::routing::post(speech))
}

pub async fn ensure_cache_dir() -> std::io::Result<()> {
    fs::create_dir_all(CACHE_DIR).await
}

#[derive(Debug, Deserialize)]
struct SpeechRequest {
    text: String,
}

#[derive(Debug, Serialize)]
struct ElevenLabsRequest<'a> {
    text: &'a str,
    model_id: &'a str,
}

async fn speech(
    State(http): State<reqwest::Client>,
    State(tts): State<SharedTts>,
    _user: CurrentUser,
    Json(req): Json<SpeechRequest>,
) -> Result<Response> {
    let text = req.text.trim();
    if text.is_empty() {
        return Ok((StatusCode::BAD_REQUEST, "text is required").into_response());
    }
    if text.chars().count() > 500 {
        return Ok((StatusCode::BAD_REQUEST, "text is too long").into_response());
    }

    let cfg = tts.read().await.clone();
    if !cfg.configured() {
        return Ok((StatusCode::SERVICE_UNAVAILABLE, "tts not configured").into_response());
    }

    match cfg.provider {
        TtsProvider::ElevenLabs => cached_elevenlabs_speech(&http, &cfg, text).await,
    }
}

async fn cached_elevenlabs_speech(
    http: &reqwest::Client,
    cfg: &crate::config::TtsConfig,
    text: &str,
) -> Result<Response> {
    let cache_path = cache_path(cfg, text);
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

    let bytes = match elevenlabs_speech(http, cfg, text).await? {
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
) -> Result<std::result::Result<Bytes, Response>> {
    let base_url = cfg.base_url.trim_end_matches('/');
    let url = format!(
        "{base_url}/v1/text-to-speech/{}?output_format={}",
        cfg.voice_id, cfg.output_format
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

fn cache_path(cfg: &crate::config::TtsConfig, text: &str) -> PathBuf {
    let provider = match cfg.provider {
        TtsProvider::ElevenLabs => "eleven_labs",
    };
    let mut hasher = Sha256::new();
    for part in [
        provider,
        cfg.base_url.trim_end_matches('/'),
        cfg.voice_id.as_str(),
        cfg.model.as_str(),
        cfg.output_format.as_str(),
        text,
    ] {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    let hash = hasher.finalize();
    PathBuf::from(CACHE_DIR).join(format!("{provider}_{hash:x}.mp3"))
}

async fn write_cache_entry(path: &PathBuf, bytes: &Bytes) -> std::io::Result<()> {
    fs::create_dir_all(CACHE_DIR).await?;
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
