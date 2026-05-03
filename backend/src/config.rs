use std::sync::Arc;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

const PATH: &str = "data/config.json";

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
