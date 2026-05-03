use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::config::{SharedTts, TtsProvider};
use crate::error::Result;

pub fn router() -> Router<crate::AppState> {
    Router::new().route("/tts/speech", axum::routing::post(speech))
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
        TtsProvider::ElevenLabs => elevenlabs_speech(&http, &cfg, text).await,
    }
}

async fn elevenlabs_speech(
    http: &reqwest::Client,
    cfg: &crate::config::TtsConfig,
    text: &str,
) -> Result<Response> {
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
        return Ok((StatusCode::BAD_GATEWAY, msg).into_response());
    }

    let bytes = res.bytes().await?;
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("audio/mpeg"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok((headers, Bytes::from(bytes)).into_response())
}
