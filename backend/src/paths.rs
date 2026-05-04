use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};

const DATA_DIR_ENV: &str = "LISTEN_PANEL_DATA_DIR";
const DEFAULT_DATA_DIR: &str = "data";
const DATA_DIR_CONFIG: &str = "data-dir.json";

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

#[derive(Debug, Serialize)]
pub struct DataDirStatus {
    pub active_dir: String,
    pub configured_dir: Option<String>,
    pub pending_dir: Option<String>,
    pub source: &'static str,
    pub restart_required: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct DataDirConfig {
    data_dir: String,
}

pub fn init() -> Result<&'static PathBuf> {
    let (dir, source) = resolve_data_dir();
    let canonical = normalize_path(dir)?;
    let initialized = DATA_DIR.get_or_init(|| canonical);
    tracing::info!(
        data_dir = %initialized.display(),
        source,
        "using listen-panel data directory"
    );
    Ok(initialized)
}

pub fn data_dir() -> PathBuf {
    DATA_DIR.get().cloned().unwrap_or_else(|| {
        normalize_path(resolve_data_dir().0).unwrap_or_else(|_| PathBuf::from(DEFAULT_DATA_DIR))
    })
}

pub fn db_path() -> PathBuf {
    data_dir().join("app.db")
}

pub fn llm_config_path() -> PathBuf {
    data_dir().join("config.json")
}

pub fn tts_config_path() -> PathBuf {
    data_dir().join("tts.json")
}

pub fn asr_config_path() -> PathBuf {
    data_dir().join("asr.json")
}

pub fn uploads_dir() -> PathBuf {
    data_dir().join("uploads")
}

pub fn tts_cache_dir() -> PathBuf {
    data_dir().join("tts-cache")
}

pub async fn status() -> Result<DataDirStatus> {
    let active_dir = data_dir_string(&data_dir());
    let configured_dir = read_configured_dir().await?;
    let pending_dir = if std::env::var(DATA_DIR_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .is_some()
    {
        None
    } else {
        configured_dir.clone()
    };
    let restart_required = pending_dir
        .as_deref()
        .map(|dir| normalize_path(dir).map(|p| data_dir_string(&p) != active_dir))
        .transpose()?
        .unwrap_or(false);
    Ok(DataDirStatus {
        active_dir,
        configured_dir,
        pending_dir,
        source: data_dir_source(),
        restart_required,
    })
}

pub async fn save_configured_dir(dir: &str) -> Result<DataDirStatus> {
    if std::env::var(DATA_DIR_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .is_some()
    {
        return Err(anyhow!(
            "{DATA_DIR_ENV} is set; unset it before changing the data directory from Settings"
        ));
    }

    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("data_dir is required"));
    }
    if trimmed.contains('\0') {
        return Err(anyhow!("data_dir contains an invalid NUL byte"));
    }
    let normalized = normalize_path(trimmed)?;
    tokio::fs::create_dir_all(&normalized).await?;
    let cfg = DataDirConfig {
        data_dir: data_dir_string(&normalized),
    };
    let body = serde_json::to_string_pretty(&cfg)?;
    let path = Path::new(DATA_DIR_CONFIG);
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, body).await?;
    tokio::fs::rename(&tmp, path).await?;
    status().await
}

fn resolve_data_dir() -> (PathBuf, &'static str) {
    if let Ok(dir) = std::env::var(DATA_DIR_ENV) {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return (PathBuf::from(trimmed), "env");
        }
    }

    if let Some(dir) = read_configured_dir_sync() {
        return (PathBuf::from(dir), "config");
    }

    (PathBuf::from(DEFAULT_DATA_DIR), "default")
}

fn data_dir_source() -> &'static str {
    if std::env::var(DATA_DIR_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .is_some()
    {
        "env"
    } else if read_configured_dir_sync().is_some() {
        "config"
    } else {
        "default"
    }
}

async fn read_configured_dir() -> Result<Option<String>> {
    let path = Path::new(DATA_DIR_CONFIG);
    let body = match tokio::fs::read_to_string(path).await {
        Ok(body) => body,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let cfg = match serde_json::from_str::<DataDirConfig>(&body) {
        Ok(cfg) => cfg,
        Err(e) => {
            tracing::warn!(
                path = DATA_DIR_CONFIG,
                "data directory config malformed ({e}); falling back to default"
            );
            return Ok(None);
        }
    };
    let trimmed = cfg.data_dir.trim();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(data_dir_string(&normalize_path(trimmed)?)))
    }
}

fn read_configured_dir_sync() -> Option<String> {
    let body = std::fs::read_to_string(DATA_DIR_CONFIG).ok()?;
    let cfg = match serde_json::from_str::<DataDirConfig>(&body) {
        Ok(cfg) => cfg,
        Err(e) => {
            tracing::warn!(
                path = DATA_DIR_CONFIG,
                "data directory config malformed ({e}); falling back to default"
            );
            return None;
        }
    };
    let trimmed = cfg.data_dir.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_path(path: impl AsRef<Path>) -> Result<PathBuf> {
    let path = path.as_ref();
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    Ok(absolute)
}

fn data_dir_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
