use std::sync::Arc;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

const PATH: &str = "data/config.json";
const TTS_PATH: &str = "data/tts.json";
const ASR_PATH: &str = "data/asr.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LlmConfig {
    #[serde(default)]
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: "https://api.deepseek.com".to_string(),
            model: "deepseek-chat".to_string(),
        }
    }
}

impl LlmConfig {
    pub fn configured(&self) -> bool {
        !self.api_key.is_empty()
    }
}

pub type SharedLlm = Arc<RwLock<LlmConfig>>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TtsProvider {
    ElevenLabs,
}

impl Default for TtsProvider {
    fn default() -> Self {
        Self::ElevenLabs
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TtsConfig {
    #[serde(default)]
    pub provider: TtsProvider,
    #[serde(default)]
    pub api_key: String,
    pub base_url: String,
    pub voice_id: String,
    pub model: String,
    pub output_format: String,
}

impl Default for TtsConfig {
    fn default() -> Self {
        Self {
            provider: TtsProvider::ElevenLabs,
            api_key: String::new(),
            base_url: "https://api.elevenlabs.io".to_string(),
            voice_id: "JBFqnCBsd6RMkjVDRZzb".to_string(),
            model: "eleven_multilingual_v2".to_string(),
            output_format: "mp3_44100_128".to_string(),
        }
    }
}

impl TtsConfig {
    pub fn configured(&self) -> bool {
        !self.api_key.is_empty()
    }
}

pub type SharedTts = Arc<RwLock<TtsConfig>>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AsrProvider {
    RemoteFasterWhisper,
}

impl Default for AsrProvider {
    fn default() -> Self {
        Self::RemoteFasterWhisper
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AsrConfig {
    #[serde(default)]
    pub provider: AsrProvider,
    pub base_url: String,
    #[serde(default)]
    pub api_token: String,
    pub backend_base_url: String,
    pub model: String,
    pub language: String,
    pub beam_size: i64,
    pub vad_filter: bool,
    pub condition_on_previous_text: bool,
    pub timeout_seconds: u64,
}

impl Default for AsrConfig {
    fn default() -> Self {
        Self {
            provider: AsrProvider::RemoteFasterWhisper,
            base_url: "http://127.0.0.1:8765".to_string(),
            api_token: String::new(),
            backend_base_url: "http://127.0.0.1:9527".to_string(),
            model: "large-v3".to_string(),
            language: "en".to_string(),
            beam_size: 5,
            vad_filter: true,
            condition_on_previous_text: false,
            timeout_seconds: 7200,
        }
    }
}

impl AsrConfig {
    pub fn configured(&self) -> bool {
        !self.base_url.trim().is_empty()
    }
}

pub type SharedAsr = Arc<RwLock<AsrConfig>>;

pub async fn load() -> SharedLlm {
    let cfg = match tokio::fs::read_to_string(PATH).await {
        Ok(s) => match serde_json::from_str::<LlmConfig>(&s) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("config.json malformed ({e}); falling back to defaults");
                LlmConfig::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => LlmConfig::default(),
        Err(e) => {
            tracing::warn!("config.json read error: {e}; falling back to defaults");
            LlmConfig::default()
        }
    };
    Arc::new(RwLock::new(cfg))
}

pub async fn save(cfg: &LlmConfig) -> Result<()> {
    let body = serde_json::to_string_pretty(cfg)?;
    let tmp = format!("{PATH}.tmp");
    tokio::fs::write(&tmp, body).await?;
    tokio::fs::rename(&tmp, PATH).await?;
    Ok(())
}

pub async fn load_tts() -> SharedTts {
    let cfg = match tokio::fs::read_to_string(TTS_PATH).await {
        Ok(s) => match serde_json::from_str::<TtsConfig>(&s) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("tts.json malformed ({e}); falling back to defaults");
                TtsConfig::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => TtsConfig::default(),
        Err(e) => {
            tracing::warn!("tts.json read error: {e}; falling back to defaults");
            TtsConfig::default()
        }
    };
    Arc::new(RwLock::new(cfg))
}

pub async fn save_tts(cfg: &TtsConfig) -> Result<()> {
    let body = serde_json::to_string_pretty(cfg)?;
    let tmp = format!("{TTS_PATH}.tmp");
    tokio::fs::write(&tmp, body).await?;
    tokio::fs::rename(&tmp, TTS_PATH).await?;
    Ok(())
}

pub async fn load_asr() -> SharedAsr {
    let cfg = match tokio::fs::read_to_string(ASR_PATH).await {
        Ok(s) => match serde_json::from_str::<AsrConfig>(&s) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("asr.json malformed ({e}); falling back to defaults");
                AsrConfig::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => AsrConfig::default(),
        Err(e) => {
            tracing::warn!("asr.json read error: {e}; falling back to defaults");
            AsrConfig::default()
        }
    };
    Arc::new(RwLock::new(cfg))
}

pub async fn save_asr(cfg: &AsrConfig) -> Result<()> {
    let body = serde_json::to_string_pretty(cfg)?;
    let tmp = format!("{ASR_PATH}.tmp");
    tokio::fs::write(&tmp, body).await?;
    tokio::fs::rename(&tmp, ASR_PATH).await?;
    Ok(())
}
