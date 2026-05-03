use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use serde::{Deserialize, Serialize};

use crate::auth::{self, CurrentUser};
use crate::config::{self, AsrProvider, SharedAsr, SharedLlm, SharedTts, TtsProvider};
use crate::error::Result;

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/settings/llm", get(get_llm).put(put_llm))
        .route("/settings/tts", get(get_tts).put(put_tts))
        .route("/settings/asr", get(get_asr).put(put_asr))
}

#[derive(Debug, Serialize)]
pub struct LlmStatus {
    pub configured: bool,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Serialize)]
pub struct TtsStatus {
    pub configured: bool,
    pub provider: TtsProvider,
    pub base_url: String,
    pub voice_id: String,
    pub model: String,
    pub output_format: String,
}

#[derive(Debug, Serialize)]
pub struct AsrStatus {
    pub configured: bool,
    pub provider: AsrProvider,
    pub base_url: String,
    pub token_configured: bool,
    pub backend_base_url: String,
    pub model: String,
    pub language: String,
    pub beam_size: i64,
    pub vad_filter: bool,
    pub condition_on_previous_text: bool,
    pub timeout_seconds: u64,
}

#[derive(Debug, Deserialize)]
pub struct UpdateLlm {
    /// Empty string or absent leaves the existing key unchanged.
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTts {
    /// Empty string or absent leaves the existing key unchanged.
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub voice_id: Option<String>,
    pub model: Option<String>,
    pub output_format: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAsr {
    /// Empty string or absent leaves the existing token unchanged.
    pub api_token: Option<String>,
    pub base_url: Option<String>,
    pub backend_base_url: Option<String>,
    pub model: Option<String>,
    pub language: Option<String>,
    pub beam_size: Option<i64>,
    pub vad_filter: Option<bool>,
    pub condition_on_previous_text: Option<bool>,
    pub timeout_seconds: Option<u64>,
}

async fn get_llm(State(llm): State<SharedLlm>, user: CurrentUser) -> axum::response::Response {
    if !user.is_admin {
        return auth::forbidden();
    }
    let g = llm.read().await;
    Json(LlmStatus {
        configured: g.configured(),
        base_url: g.base_url.clone(),
        model: g.model.clone(),
    })
    .into_response()
}

async fn put_llm(
    State(llm): State<SharedLlm>,
    user: CurrentUser,
    Json(patch): Json<UpdateLlm>,
) -> Result<axum::response::Response> {
    if !user.is_admin {
        return Ok(auth::forbidden());
    }
    let snapshot = {
        let mut g = llm.write().await;
        if let Some(k) = patch.api_key {
            let trimmed = k.trim();
            if !trimmed.is_empty() {
                g.api_key = trimmed.to_string();
            }
        }
        if let Some(b) = patch.base_url {
            let trimmed = b.trim();
            if !trimmed.is_empty() {
                g.base_url = trimmed.to_string();
            }
        }
        if let Some(m) = patch.model {
            let trimmed = m.trim();
            if !trimmed.is_empty() {
                g.model = trimmed.to_string();
            }
        }
        g.clone()
    };

    config::save(&snapshot).await?;

    Ok(Json(LlmStatus {
        configured: snapshot.configured(),
        base_url: snapshot.base_url,
        model: snapshot.model,
    }))
    .map(axum::response::IntoResponse::into_response)
}

async fn get_tts(State(tts): State<SharedTts>, user: CurrentUser) -> axum::response::Response {
    if !user.is_admin {
        return auth::forbidden();
    }
    let g = tts.read().await;
    Json(TtsStatus {
        configured: g.configured(),
        provider: g.provider.clone(),
        base_url: g.base_url.clone(),
        voice_id: g.voice_id.clone(),
        model: g.model.clone(),
        output_format: g.output_format.clone(),
    })
    .into_response()
}

async fn put_tts(
    State(tts): State<SharedTts>,
    user: CurrentUser,
    Json(patch): Json<UpdateTts>,
) -> Result<axum::response::Response> {
    if !user.is_admin {
        return Ok(auth::forbidden());
    }
    let snapshot = {
        let mut g = tts.write().await;
        if let Some(k) = patch.api_key {
            let trimmed = k.trim();
            if !trimmed.is_empty() {
                g.api_key = trimmed.to_string();
            }
        }
        if let Some(b) = patch.base_url {
            let trimmed = b.trim();
            if !trimmed.is_empty() {
                g.base_url = trimmed.to_string();
            }
        }
        if let Some(v) = patch.voice_id {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                g.voice_id = trimmed.to_string();
            }
        }
        if let Some(m) = patch.model {
            let trimmed = m.trim();
            if !trimmed.is_empty() {
                g.model = trimmed.to_string();
            }
        }
        if let Some(f) = patch.output_format {
            let trimmed = f.trim();
            if !trimmed.is_empty() {
                g.output_format = trimmed.to_string();
            }
        }
        g.clone()
    };

    config::save_tts(&snapshot).await?;

    Ok(Json(TtsStatus {
        configured: snapshot.configured(),
        provider: snapshot.provider,
        base_url: snapshot.base_url,
        voice_id: snapshot.voice_id,
        model: snapshot.model,
        output_format: snapshot.output_format,
    }))
    .map(axum::response::IntoResponse::into_response)
}

async fn get_asr(State(asr): State<SharedAsr>, user: CurrentUser) -> axum::response::Response {
    if !user.is_admin {
        return auth::forbidden();
    }
    let g = asr.read().await;
    Json(AsrStatus {
        configured: g.configured(),
        provider: g.provider.clone(),
        base_url: g.base_url.clone(),
        token_configured: !g.api_token.is_empty(),
        backend_base_url: g.backend_base_url.clone(),
        model: g.model.clone(),
        language: g.language.clone(),
        beam_size: g.beam_size,
        vad_filter: g.vad_filter,
        condition_on_previous_text: g.condition_on_previous_text,
        timeout_seconds: g.timeout_seconds,
    })
    .into_response()
}

async fn put_asr(
    State(asr): State<SharedAsr>,
    user: CurrentUser,
    Json(patch): Json<UpdateAsr>,
) -> Result<axum::response::Response> {
    if !user.is_admin {
        return Ok(auth::forbidden());
    }
    let snapshot = {
        let mut g = asr.write().await;
        if let Some(t) = patch.api_token {
            let trimmed = t.trim();
            if !trimmed.is_empty() {
                g.api_token = trimmed.to_string();
            }
        }
        if let Some(b) = patch.base_url {
            let trimmed = b.trim();
            if !trimmed.is_empty() {
                g.base_url = trimmed.to_string();
            }
        }
        if let Some(b) = patch.backend_base_url {
            let trimmed = b.trim();
            if !trimmed.is_empty() {
                g.backend_base_url = trimmed.to_string();
            }
        }
        if let Some(m) = patch.model {
            let trimmed = m.trim();
            if !trimmed.is_empty() {
                g.model = trimmed.to_string();
            }
        }
        if let Some(l) = patch.language {
            let trimmed = l.trim();
            if !trimmed.is_empty() {
                g.language = trimmed.to_string();
            }
        }
        if let Some(beam_size) = patch.beam_size {
            if beam_size > 0 {
                g.beam_size = beam_size;
            }
        }
        if let Some(vad_filter) = patch.vad_filter {
            g.vad_filter = vad_filter;
        }
        if let Some(condition_on_previous_text) = patch.condition_on_previous_text {
            g.condition_on_previous_text = condition_on_previous_text;
        }
        if let Some(timeout_seconds) = patch.timeout_seconds {
            if timeout_seconds >= 60 {
                g.timeout_seconds = timeout_seconds;
            }
        }
        g.clone()
    };

    config::save_asr(&snapshot).await?;

    Ok(Json(AsrStatus {
        configured: snapshot.configured(),
        provider: snapshot.provider,
        base_url: snapshot.base_url,
        token_configured: !snapshot.api_token.is_empty(),
        backend_base_url: snapshot.backend_base_url,
        model: snapshot.model,
        language: snapshot.language,
        beam_size: snapshot.beam_size,
        vad_filter: snapshot.vad_filter,
        condition_on_previous_text: snapshot.condition_on_previous_text,
        timeout_seconds: snapshot.timeout_seconds,
    }))
    .map(axum::response::IntoResponse::into_response)
}
