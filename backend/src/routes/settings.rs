use std::time::Instant;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::{self, CurrentUser};
use crate::config::{self, AsrProvider, SharedAsr, SharedLlm, SharedTts, TtsProvider};
use crate::error::Result;
use crate::llm_call::salvage_json;
use crate::paths::DataDirStatus;

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/settings/llm", get(get_llm).put(put_llm))
        .route("/settings/llm/health-check", post(check_llm_health))
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
    /// Whether the fallback provider (used only when primary times out / 5xx)
    /// has all three of api_key/base_url/model set.
    pub fallback_configured: bool,
    pub fallback_base_url: String,
    pub fallback_model: String,
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
    /// Same semantics for the fallback provider. Setting all three lights up
    /// fallback; clearing the key disables it (no longer "configured").
    pub fallback_api_key: Option<String>,
    pub fallback_base_url: Option<String>,
    pub fallback_model: Option<String>,
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
        fallback_configured: g.fallback_configured(),
        fallback_base_url: g.fallback_base_url.clone(),
        fallback_model: g.fallback_model.clone(),
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
        // Fallback fields: same "empty string preserves existing" semantics for
        // the key (so the form can hide it after first save), but base_url and
        // model just track whatever the form sends so you can edit / clear them.
        if let Some(k) = patch.fallback_api_key {
            let trimmed = k.trim();
            if !trimmed.is_empty() {
                g.fallback_api_key = trimmed.to_string();
            }
        }
        if let Some(b) = patch.fallback_base_url {
            g.fallback_base_url = b.trim().to_string();
        }
        if let Some(m) = patch.fallback_model {
            g.fallback_model = m.trim().to_string();
        }
        g.clone()
    };

    config::save(&snapshot).await?;

    // Capture the booleans before moving any owned strings out of snapshot.
    let configured = snapshot.configured();
    let fallback_configured = snapshot.fallback_configured();
    Ok(Json(LlmStatus {
        configured,
        base_url: snapshot.base_url,
        model: snapshot.model,
        fallback_configured,
        fallback_base_url: snapshot.fallback_base_url,
        fallback_model: snapshot.fallback_model,
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

// ─────────────────────────── LLM health check ───────────────────────────
//
// "Does this key + base_url + model actually return a usable response?"
// Used by the test buttons next to each provider block in Settings. The
// form sends whatever the user has currently typed; blank fields fall back
// to the saved config so the user can verify the live config too.

#[derive(Debug, Deserialize)]
pub struct CheckLlmHealth {
    /// Which of the two slots in `LlmConfig` to test.
    pub which: LlmHealthTarget,
    /// Empty string or absent → use the saved key.
    #[serde(default)]
    pub api_key: Option<String>,
    /// Empty string or absent → use the saved base_url.
    #[serde(default)]
    pub base_url: Option<String>,
    /// Empty string or absent → use the saved model.
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum LlmHealthTarget {
    Primary,
    Fallback,
}

#[derive(Debug, Serialize)]
pub struct LlmHealthStatus {
    pub ok: bool,
    pub which: LlmHealthTarget,
    pub base_url: String,
    pub model: String,
    pub latency_ms: u128,
    /// HTTP status from the upstream, when we got a response at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// Whether the model returned a value that parses as JSON. Useful: a
    /// provider can be reachable but not support `response_format`, in which
    /// case it'll return free text and the app's JSON-mode calls will fail.
    pub json_mode_ok: bool,
    /// First ~200 chars of `choices[0].message.content`, for sanity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_preview: Option<String>,
    /// Populated when the call failed at any stage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

async fn check_llm_health(
    State(llm): State<SharedLlm>,
    State(http): State<reqwest::Client>,
    user: CurrentUser,
    Json(req): Json<CheckLlmHealth>,
) -> Result<Json<LlmHealthStatus>> {
    if !user.is_admin {
        return Ok(Json(LlmHealthStatus {
            ok: false,
            which: req.which,
            base_url: String::new(),
            model: String::new(),
            latency_ms: 0,
            status: None,
            json_mode_ok: false,
            content_preview: None,
            error: Some("admin only".to_string()),
        }));
    }

    // Resolve the three credentials. Empty strings fall back to the saved
    // config so the user can probe their live config without retyping the
    // key — same convention as the ASR health check.
    let saved = llm.read().await.clone();
    let (saved_key, saved_url, saved_model) = match req.which {
        LlmHealthTarget::Primary => (saved.api_key, saved.base_url, saved.model),
        LlmHealthTarget::Fallback => (
            saved.fallback_api_key,
            saved.fallback_base_url,
            saved.fallback_model,
        ),
    };
    let key = req
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or(saved_key);
    let url = req
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or(saved_url);
    let model = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or(saved_model);

    if key.is_empty() || url.is_empty() || model.is_empty() {
        return Ok(Json(LlmHealthStatus {
            ok: false,
            which: req.which,
            base_url: url,
            model,
            latency_ms: 0,
            status: None,
            json_mode_ok: false,
            content_preview: None,
            error: Some(
                "missing fields — fill key, base_url and model (or save them) first".to_string(),
            ),
        }));
    }

    let endpoint = format!("{}/chat/completions", url.trim_end_matches('/'));
    let started = Instant::now();

    // First attempt: with `response_format: json_object`. This is what the
    // app actually uses in production, so passing here means "really works."
    //
    // Why the verbose system prompt: a casual prompt like "reply with JSON"
    // makes some providers (notably Gemini's OpenAI-compat) ignore the
    // response_format flag and prefix the JSON with "Here is the JSON
    // requested: …", which fails JSON parsing. The real app's prompts have
    // strong JSON-only framing — we mirror that here so the test reflects
    // production behavior, not an artificially loose test.
    let json_body = json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "You are a JSON-only API. Output a single valid JSON object and \
                            nothing else — no markdown fences, no commentary, no leading or \
                            trailing prose. Exactly one JSON object."
            },
            {
                "role": "user",
                "content": "Return this JSON object: {\"ok\": true}"
            }
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0,
        // 32 was too tight for Gemini: it spent the budget on "Here is the
        // JSON requested: ```" before reaching the `{`. 256 is comfortably
        // larger than any salvage-worthy prose prefix while still keeping
        // the probe cheap.
        "max_tokens": 256,
    });
    let first = probe_once(&http, &endpoint, &key, &json_body).await;

    // Categorize: if the provider explicitly rejected `response_format` /
    // `json_object`, the API itself may be fine but JSON mode is unsupported.
    // Retry once without response_format to confirm that distinction.
    let response_format_rejected = matches!(
        &first,
        ProbeOutcome::Http { status, body }
            if *status == 400 && body_mentions_response_format(body)
    );

    if response_format_rejected {
        let plain_body = json!({
            "model": model,
            "messages": [
                { "role": "user", "content": "Reply with the string ok." }
            ],
            "temperature": 0,
            "max_tokens": 256,
        });
        let retry = probe_once(&http, &endpoint, &key, &plain_body).await;
        let latency_ms = started.elapsed().as_millis();
        return Ok(Json(match retry {
            ProbeOutcome::Ok { status, content } => LlmHealthStatus {
                // API itself works, but app calls *will* break because we
                // need JSON mode for every prompt. Surface as not-ok so the
                // user doesn't save this provider thinking it's wired up.
                ok: false,
                which: req.which,
                base_url: url,
                model,
                latency_ms,
                status: Some(status),
                json_mode_ok: false,
                content_preview: content.map(|s| s.chars().take(200).collect()),
                error: Some(
                    "API 通,但模型不支持 response_format: json_object — 本应用所有调用都依赖 \
                     JSON mode,这个 provider 不能直接当兜底。换支持 json_object 的 provider \
                     (推荐 Gemini,或 Kimi / 通义千问 / 火山方舟托管的 DeepSeek)。"
                        .to_string(),
                ),
            },
            ProbeOutcome::Http { status, body } => LlmHealthStatus {
                ok: false,
                which: req.which,
                base_url: url,
                model,
                latency_ms,
                status: Some(status),
                json_mode_ok: false,
                content_preview: None,
                error: Some(format!("retry without response_format also failed: HTTP {status}: {body}")),
            },
            ProbeOutcome::Network(e) => LlmHealthStatus {
                ok: false,
                which: req.which,
                base_url: url,
                model,
                latency_ms,
                status: None,
                json_mode_ok: false,
                content_preview: None,
                error: Some(format!("retry network: {e}")),
            },
        }));
    }

    // Not the "response_format unsupported" case — report the first attempt's
    // result directly.
    let latency_ms = started.elapsed().as_millis();
    Ok(Json(match first {
        ProbeOutcome::Ok { status, content } => {
            // Preview shows the raw model output (with any prose) so the
            // user can see what the model actually said. But `json_mode_ok`
            // reflects whether the cleanup we apply in production can
            // extract valid JSON — that's the relevant signal for "will
            // the app work with this provider."
            let preview = content
                .as_ref()
                .map(|s| s.chars().take(200).collect::<String>());
            let json_mode_ok = content
                .as_deref()
                .map(|s| serde_json::from_str::<Value>(&salvage_json(s)).is_ok())
                .unwrap_or(false);
            LlmHealthStatus {
                ok: true,
                which: req.which,
                base_url: url,
                model,
                latency_ms,
                status: Some(status),
                json_mode_ok,
                content_preview: preview,
                error: None,
            }
        }
        ProbeOutcome::Http { status, body } => LlmHealthStatus {
            ok: false,
            which: req.which,
            base_url: url,
            model,
            latency_ms,
            status: Some(status),
            json_mode_ok: false,
            content_preview: None,
            error: Some(if body.is_empty() {
                format!("HTTP {status}")
            } else {
                format!("HTTP {status}: {body}")
            }),
        },
        ProbeOutcome::Network(e) => LlmHealthStatus {
            ok: false,
            which: req.which,
            base_url: url,
            model,
            latency_ms,
            status: None,
            json_mode_ok: false,
            content_preview: None,
            error: Some(format!("network: {e}")),
        },
    }))
}

enum ProbeOutcome {
    /// 2xx with parsed content (or no content found).
    Ok {
        status: u16,
        content: Option<String>,
    },
    /// Non-2xx HTTP with an upstream error body (trimmed).
    Http { status: u16, body: String },
    /// Failed to even get an HTTP response (timeout / connect / DNS / decode).
    Network(String),
}

async fn probe_once(
    http: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    body: &Value,
) -> ProbeOutcome {
    let res = match http.post(endpoint).bearer_auth(api_key).json(body).send().await {
        Ok(r) => r,
        Err(e) => return ProbeOutcome::Network(format!("{e}")),
    };
    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return ProbeOutcome::Http {
            status: status.as_u16(),
            body: text.chars().take(400).collect(),
        };
    }
    let raw: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => return ProbeOutcome::Network(format!("response decode: {e}")),
    };
    let content = raw
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|s| s.as_str())
        .map(str::to_string);
    ProbeOutcome::Ok {
        status: status.as_u16(),
        content,
    }
}

/// Heuristic match for "this provider doesn't grok our response_format value."
/// Different providers phrase the error differently — we just look for either
/// keyword and trust the retry-without-`response_format` to confirm.
fn body_mentions_response_format(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.contains("response_format") || lower.contains("json_object")
}
