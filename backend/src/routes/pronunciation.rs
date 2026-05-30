use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Multipart, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::CurrentUser;
use crate::config::SharedTts;
use crate::error::Result;
use crate::language::Language;

pub fn router() -> Router<crate::AppState> {
    Router::new().route(
        "/pronunciation/assess",
        // 16kHz mono 16-bit WAV of <=60s audio is ~1.9MB; 16 MiB is generous
        // headroom while still rejecting anything that isn't a short clip.
        axum::routing::post(assess).layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
    )
}

/// Azure short-audio pronunciation assessment runs against a clip; the round
/// trip is normally a few seconds but allow slack for upload + processing.
const AZURE_TIMEOUT_SECS: u64 = 60;

/// Per-word result surfaced to the UI. `error_type` is Azure's classification:
/// "None" / "Mispronunciation" / "Omission" / "Insertion" / "UnexpectedBreak" /
/// "MissingBreak" / "Monotone".
#[derive(Debug, Serialize)]
struct PronunciationWord {
    word: String,
    accuracy: Option<f64>,
    error_type: String,
    /// Phoneme-level breakdown (IPA), so the UI can point at the exact sounds
    /// that dragged a word's score down.
    phonemes: Vec<PhonemeScore>,
}

#[derive(Debug, Serialize)]
struct PhonemeScore {
    phoneme: String,
    accuracy: Option<f64>,
}

#[derive(Debug, Serialize)]
struct PronunciationResult {
    recognition_status: String,
    recognized_text: String,
    accuracy: Option<f64>,
    fluency: Option<f64>,
    completeness: Option<f64>,
    prosody: Option<f64>,
    pron_score: Option<f64>,
    words: Vec<PronunciationWord>,
}

// --- Azure detailed-response shapes (PascalCase) ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct AzureResponse {
    recognition_status: String,
    #[serde(default)]
    n_best: Vec<AzureNBest>,
}

// Azure's REST detailed response puts the assessment scores *flat* on each
// NBest item and word (AccuracyScore, PronScore, …) — not nested under a
// "PronunciationAssessment" object as the SDK/docs samples suggest.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct AzureNBest {
    #[serde(default)]
    display: String,
    accuracy_score: Option<f64>,
    fluency_score: Option<f64>,
    completeness_score: Option<f64>,
    prosody_score: Option<f64>,
    pron_score: Option<f64>,
    #[serde(default)]
    words: Vec<AzureWord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct AzureWord {
    #[serde(default)]
    word: String,
    accuracy_score: Option<f64>,
    #[serde(default)]
    error_type: Option<String>,
    #[serde(default)]
    phonemes: Vec<AzurePhoneme>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct AzurePhoneme {
    #[serde(default)]
    phoneme: String,
    accuracy_score: Option<f64>,
}

async fn assess(
    State(tts): State<SharedTts>,
    _user: CurrentUser,
    mut multipart: Multipart,
) -> Result<Response> {
    let mut audio: Option<Vec<u8>> = None;
    let mut reference_text = String::new();
    let mut language = String::new();

    while let Some(field) = multipart.next_field().await.map_err(anyhow::Error::from)? {
        match field.name().unwrap_or("") {
            "audio" => {
                audio = Some(field.bytes().await.map_err(anyhow::Error::from)?.to_vec());
            }
            "reference_text" => {
                reference_text = field.text().await.map_err(anyhow::Error::from)?;
            }
            "language" => {
                language = field.text().await.map_err(anyhow::Error::from)?;
            }
            _ => {}
        }
    }

    let Some(audio) = audio else {
        return Ok((StatusCode::BAD_REQUEST, "missing 'audio' field").into_response());
    };
    if audio.is_empty() {
        return Ok((StatusCode::BAD_REQUEST, "audio is empty").into_response());
    }
    let reference_text = reference_text.trim();
    if reference_text.is_empty() {
        return Ok((StatusCode::BAD_REQUEST, "reference_text is required").into_response());
    }
    if reference_text.chars().count() > 1000 {
        return Ok((StatusCode::BAD_REQUEST, "reference_text is too long").into_response());
    }

    let cfg = tts.read().await.clone();
    if !cfg.configured() {
        return Ok((
            StatusCode::SERVICE_UNAVAILABLE,
            "Azure Speech not configured; set the key and region on the Settings page",
        )
            .into_response());
    }
    let region = cfg.region.trim();
    // The assessment locale must match how the user is reading. Reuse the same
    // locale derivation TTS uses (en-US / ja-JP) so both features stay in sync.
    let locale = cfg.xml_lang_for(&Language::normalize(&language));

    let assessment_config = json!({
        "ReferenceText": reference_text,
        "GradingSystem": "HundredMark",
        // Phoneme granularity returns per-sound scores so the UI can pinpoint
        // which sounds need work; IPA is the alphabet learners recognize.
        "Granularity": "Phoneme",
        "PhonemeAlphabet": "IPA",
        "Dimension": "Comprehensive",
        "EnableProsodyAssessment": true,
    });
    let assessment_header = BASE64.encode(serde_json::to_vec(&assessment_config)?);

    let url = format!(
        "https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language={locale}&format=detailed"
    );
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(AZURE_TIMEOUT_SECS))
        .build()?;

    let res = http
        .post(&url)
        .header("Ocp-Apim-Subscription-Key", &cfg.api_key)
        .header(
            "Content-Type",
            "audio/wav; codecs=audio/pcm; samplerate=16000",
        )
        .header("Pronunciation-Assessment", assessment_header)
        .header("Accept", "application/json")
        .header("User-Agent", "listen-panel")
        .body(audio)
        .send()
        .await?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        let msg = if body.trim().is_empty() {
            format!("Azure pronunciation assessment returned {status}")
        } else {
            format!(
                "Azure pronunciation assessment returned {status}: {}",
                body.chars().take(300).collect::<String>()
            )
        };
        tracing::warn!("{msg}");
        return Ok((StatusCode::BAD_GATEWAY, msg).into_response());
    }

    let raw = res.text().await?;
    let parsed: AzureResponse = serde_json::from_str(&raw).map_err(|e| {
        tracing::warn!("failed to parse Azure response: {e}; body: {raw}");
        anyhow::anyhow!("could not parse Azure response: {e}")
    })?;
    let best = parsed.n_best.into_iter().next();

    // Recognition can succeed while Azure declines to return assessment scores
    // (e.g. audio over the short-audio limit, or a rejected assessment header).
    if best.as_ref().and_then(|b| b.pron_score).is_none() {
        tracing::warn!(
            "Azure recognized speech but returned no pronunciation scores (status={})",
            parsed.recognition_status,
        );
    }

    let result = PronunciationResult {
        recognition_status: parsed.recognition_status,
        recognized_text: best.as_ref().map(|b| b.display.clone()).unwrap_or_default(),
        accuracy: best.as_ref().and_then(|b| b.accuracy_score),
        fluency: best.as_ref().and_then(|b| b.fluency_score),
        completeness: best.as_ref().and_then(|b| b.completeness_score),
        prosody: best.as_ref().and_then(|b| b.prosody_score),
        pron_score: best.as_ref().and_then(|b| b.pron_score),
        words: best
            .map(|b| {
                b.words
                    .into_iter()
                    .map(|w| PronunciationWord {
                        word: w.word,
                        accuracy: w.accuracy_score,
                        error_type: w.error_type.unwrap_or_else(|| "None".to_string()),
                        phonemes: w
                            .phonemes
                            .into_iter()
                            .map(|p| PhonemeScore {
                                phoneme: p.phoneme,
                                accuracy: p.accuracy_score,
                            })
                            .collect(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    };

    Ok(Json(result).into_response())
}
