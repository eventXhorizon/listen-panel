use std::time::Instant;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::auth::{self, CurrentUser};
use crate::config::{self, AsrProvider, SharedAsr, SharedLlm, SharedTts, TtsProvider};
use crate::error::Result;
use crate::paths::DataDirStatus;

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/settings/llm", get(get_llm).put(put_llm))
        .route("/settings/tts", get(get_tts).put(put_tts))
        .route("/settings/asr/health-check", post(check_asr_health))
        .route("/settings/asr", get(get_asr).put(put_asr))
        .route("/settings/data-dir", get(get_data_dir).put(put_data_dir))
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
    pub region: String,
    pub voice_id_en: String,
    pub voice_id_ja: String,
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
    pub high_accuracy: bool,
    pub timeout_seconds: u64,
}

#[derive(Debug, Serialize)]
pub struct AsrHealthCheckStatus {
    pub ok: bool,
    pub configured: bool,
    pub base_url: String,
    pub token_configured: bool,
    pub checked_at: DateTime<Utc>,
    pub health: WorkerEndpointProbe,
    pub capabilities: WorkerEndpointProbe,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker: Option<WorkerSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkerEndpointProbe {
    pub ok: bool,
    pub status: Option<u16>,
    pub latency_ms: u128,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WorkerSummary {
    pub service: Option<String>,
    pub version: Option<String>,
    pub queue: Option<String>,
    pub max_concurrent_jobs: Option<i64>,
    pub device: Option<String>,
    pub compute_type: Option<String>,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateDataDir {
    pub data_dir: String,
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
    pub region: Option<String>,
    pub voice_id_en: Option<String>,
    pub voice_id_ja: Option<String>,
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
    pub high_accuracy: Option<bool>,
    pub timeout_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct CheckAsrHealth {
    /// Optional unsaved URL from the settings form.
    pub base_url: Option<String>,
    /// Empty string or absent uses the currently saved token.
    pub api_token: Option<String>,
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
        region: g.region.clone(),
        voice_id_en: g.voice_id_en.clone(),
        voice_id_ja: g.voice_id_ja.clone(),
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
        if let Some(r) = patch.region {
            let trimmed = r.trim();
            if !trimmed.is_empty() {
                g.region = trimmed.to_string();
            }
        }
        if let Some(v) = patch.voice_id_en {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                g.voice_id_en = trimmed.to_string();
            }
        }
        if let Some(v) = patch.voice_id_ja {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                g.voice_id_ja = trimmed.to_string();
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
        region: snapshot.region,
        voice_id_en: snapshot.voice_id_en,
        voice_id_ja: snapshot.voice_id_ja,
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
        high_accuracy: g.high_accuracy,
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
        if let Some(high_accuracy) = patch.high_accuracy {
            g.high_accuracy = high_accuracy;
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
        high_accuracy: snapshot.high_accuracy,
        timeout_seconds: snapshot.timeout_seconds,
    }))
    .map(axum::response::IntoResponse::into_response)
}

async fn check_asr_health(
    State(asr): State<SharedAsr>,
    user: CurrentUser,
    Json(input): Json<CheckAsrHealth>,
) -> Result<axum::response::Response> {
    if !user.is_admin {
        return Ok(auth::forbidden());
    }

    let cfg = asr.read().await.clone();
    let base_url = input
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(cfg.base_url.trim())
        .trim_end_matches('/')
        .to_string();
    let api_token = input
        .api_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(cfg.api_token.trim())
        .to_string();

    if base_url.is_empty() {
        let skipped = WorkerEndpointProbe {
            ok: false,
            status: None,
            latency_ms: 0,
            error: Some("ASR worker base URL is empty".to_string()),
        };
        return Ok(Json(AsrHealthCheckStatus {
            ok: false,
            configured: false,
            base_url,
            token_configured: !api_token.is_empty(),
            checked_at: Utc::now(),
            health: skipped.clone(),
            capabilities: skipped,
            worker: None,
        })
        .into_response());
    }

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(5))
        .build()?;
    let health_url = format!("{base_url}/health");
    let capabilities_url = format!("{base_url}/v1/capabilities");
    let health = probe_worker_endpoint(&client, &health_url, None).await;
    let capabilities =
        probe_worker_endpoint(&client, &capabilities_url, Some(api_token.as_str())).await;
    let worker = capabilities
        .body
        .as_ref()
        .and_then(worker_summary_from_capabilities);
    let health_probe = health.into_probe();
    let capabilities_probe = capabilities.into_probe();

    Ok(Json(AsrHealthCheckStatus {
        ok: health_probe.ok && capabilities_probe.ok,
        configured: cfg.configured(),
        base_url,
        token_configured: !api_token.is_empty(),
        checked_at: Utc::now(),
        health: health_probe,
        capabilities: capabilities_probe,
        worker,
    })
    .into_response())
}

async fn get_data_dir(user: CurrentUser) -> Result<axum::response::Response> {
    if !user.is_admin {
        return Ok(auth::forbidden());
    }
    let status = crate::paths::status().await?;
    Ok(Json(status).into_response())
}

async fn put_data_dir(
    user: CurrentUser,
    Json(patch): Json<UpdateDataDir>,
) -> Result<axum::response::Response> {
    if !user.is_admin {
        return Ok(auth::forbidden());
    }
    let status: DataDirStatus = crate::paths::save_configured_dir(&patch.data_dir).await?;
    Ok(Json(status).into_response())
}

#[derive(Debug, Clone)]
struct WorkerEndpointResult {
    ok: bool,
    status: Option<u16>,
    latency_ms: u128,
    error: Option<String>,
    body: Option<Value>,
}

impl WorkerEndpointResult {
    fn into_probe(self) -> WorkerEndpointProbe {
        WorkerEndpointProbe {
            ok: self.ok,
            status: self.status,
            latency_ms: self.latency_ms,
            error: self.error,
        }
    }
}

async fn probe_worker_endpoint(
    client: &reqwest::Client,
    url: &str,
    api_token: Option<&str>,
) -> WorkerEndpointResult {
    let started = Instant::now();
    let mut req = client.get(url);
    if let Some(token) = api_token.map(str::trim).filter(|value| !value.is_empty()) {
        req = req.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let response = match req.send().await {
        Ok(response) => response,
        Err(err) => {
            return WorkerEndpointResult {
                ok: false,
                status: None,
                latency_ms: started.elapsed().as_millis(),
                error: Some(err.to_string()),
                body: None,
            };
        }
    };
    let status = response.status();
    let text = match response.text().await {
        Ok(text) => text,
        Err(err) => {
            return WorkerEndpointResult {
                ok: false,
                status: Some(status.as_u16()),
                latency_ms: started.elapsed().as_millis(),
                error: Some(err.to_string()),
                body: None,
            };
        }
    };
    let body = serde_json::from_str::<Value>(&text).ok();
    WorkerEndpointResult {
        ok: status.is_success(),
        status: Some(status.as_u16()),
        latency_ms: started.elapsed().as_millis(),
        error: if status.is_success() {
            None
        } else {
            Some(trim_probe_body(&text))
        },
        body,
    }
}

fn trim_probe_body(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "empty response body".to_string();
    }
    trimmed.chars().take(500).collect()
}

fn worker_summary_from_capabilities(value: &Value) -> Option<WorkerSummary> {
    let object = value.as_object()?;
    Some(WorkerSummary {
        service: object
            .get("service")
            .and_then(Value::as_str)
            .map(str::to_string),
        version: object
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string),
        queue: object
            .get("queue")
            .and_then(Value::as_str)
            .map(str::to_string),
        max_concurrent_jobs: object.get("max_concurrent_jobs").and_then(Value::as_i64),
        device: object
            .get("device")
            .and_then(Value::as_str)
            .map(str::to_string),
        compute_type: object
            .get("compute_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        capabilities: object
            .get("capabilities")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("type").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    })
}
