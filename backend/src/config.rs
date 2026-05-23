use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

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
    Azure,
}

impl Default for TtsProvider {
    fn default() -> Self {
        Self::Azure
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TtsConfig {
    #[serde(default)]
    pub provider: TtsProvider,
    /// Azure Speech subscription key.
    #[serde(default)]
    pub api_key: String,
    /// Azure region slug, e.g. "eastus" or "japaneast". Drives the endpoint URL.
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub voice_id_en: String,
    #[serde(default)]
    pub voice_id_ja: String,
    /// Azure audio output spec, e.g. "audio-48khz-192kbitrate-mono-mp3".
    #[serde(default)]
    pub output_format: String,
}

impl Default for TtsConfig {
    fn default() -> Self {
        Self {
            provider: TtsProvider::Azure,
            api_key: String::new(),
            region: "eastus".to_string(),
            voice_id_en: "en-US-AriaNeural".to_string(),
            voice_id_ja: "ja-JP-NanamiNeural".to_string(),
            output_format: "audio-48khz-192kbitrate-mono-mp3".to_string(),
        }
    }
}

impl TtsConfig {
    pub fn configured(&self) -> bool {
        !self.api_key.is_empty() && !self.region.is_empty()
    }

    /// Pick the voice ID for the given language. Falls back to en when JA is
    /// unset or language is unknown.
    pub fn voice_for_language(&self, language: &str) -> &str {
        match language {
            "ja" if !self.voice_id_ja.is_empty() => &self.voice_id_ja,
            _ => &self.voice_id_en,
        }
    }

    /// Azure SSML expects a BCP-47 tag in `xml:lang`. The voice ID itself
    /// starts with the locale (`en-US-AriaNeural` / `ja-JP-NanamiNeural`),
    /// so we parse the prefix.
    pub fn xml_lang_for(&self, language: &str) -> &str {
        let voice = self.voice_for_language(language);
        // Locale is always "<lang>-<region>" — find the index of the third '-'.
        let mut dash_count = 0usize;
        for (i, ch) in voice.char_indices() {
            if ch == '-' {
                dash_count += 1;
                if dash_count == 2 {
                    return &voice[..i];
                }
            }
        }
        match language {
            "ja" => "ja-JP",
            _ => "en-US",
        }
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
    #[serde(default = "default_asr_high_accuracy")]
    pub high_accuracy: bool,
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
            high_accuracy: true,
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

fn default_asr_high_accuracy() -> bool {
    true
}

pub async fn load() -> SharedLlm {
    let path = crate::paths::llm_config_path();
    let cfg = match tokio::fs::read_to_string(&path).await {
        Ok(s) => match serde_json::from_str::<LlmConfig>(&s) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    "config.json malformed ({e}); falling back to defaults"
                );
                LlmConfig::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => LlmConfig::default(),
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                "config.json read error: {e}; falling back to defaults"
            );
            LlmConfig::default()
        }
    };
    Arc::new(RwLock::new(cfg))
}

pub async fn save(cfg: &LlmConfig) -> Result<()> {
    write_json_atomic(crate::paths::llm_config_path(), cfg).await
}

pub async fn load_tts() -> SharedTts {
    let path = crate::paths::tts_config_path();
    let mut cfg = match tokio::fs::read_to_string(&path).await {
        Ok(s) => match serde_json::from_str::<TtsConfig>(&s) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    "tts.json malformed ({e}); falling back to defaults"
                );
                TtsConfig::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => TtsConfig::default(),
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                "tts.json read error: {e}; falling back to defaults"
            );
            TtsConfig::default()
        }
    };
    // Fill in defaults for any fields the loaded JSON doesn't have (covers
    // both a fresh install and an old ElevenLabs-era tts.json that was wiped
    // back to defaults because the provider enum changed).
    let defaults = TtsConfig::default();
    if cfg.region.is_empty() {
        cfg.region = defaults.region;
    }
    if cfg.voice_id_en.is_empty() {
        cfg.voice_id_en = defaults.voice_id_en;
    }
    if cfg.voice_id_ja.is_empty() {
        cfg.voice_id_ja = defaults.voice_id_ja;
    }
    if cfg.output_format.is_empty() {
        cfg.output_format = defaults.output_format;
    }
    Arc::new(RwLock::new(cfg))
}

pub async fn save_tts(cfg: &TtsConfig) -> Result<()> {
    write_json_atomic(crate::paths::tts_config_path(), cfg).await
}

pub async fn load_asr() -> SharedAsr {
    let path = crate::paths::asr_config_path();
    let cfg = match tokio::fs::read_to_string(&path).await {
        Ok(s) => match serde_json::from_str::<AsrConfig>(&s) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    "asr.json malformed ({e}); falling back to defaults"
                );
                AsrConfig::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => AsrConfig::default(),
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                "asr.json read error: {e}; falling back to defaults"
            );
            AsrConfig::default()
        }
    };
    Arc::new(RwLock::new(cfg))
}

pub async fn save_asr(cfg: &AsrConfig) -> Result<()> {
    write_json_atomic(crate::paths::asr_config_path(), cfg).await
}

async fn write_json_atomic<T>(path: PathBuf, cfg: &T) -> Result<()>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let body = serde_json::to_string_pretty(cfg)?;
    let tmp = tmp_path(&path);
    tokio::fs::write(&tmp, body).await?;
    tokio::fs::rename(&tmp, &path).await?;
    Ok(())
}

fn tmp_path(path: &Path) -> PathBuf {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config.json");
    path.with_file_name(format!("{filename}.tmp"))
}
