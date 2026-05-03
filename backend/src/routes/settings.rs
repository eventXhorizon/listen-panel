use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::routing::get;
use serde::{Deserialize, Serialize};

use crate::config::{self, SharedLlm};
use crate::error::Result;

pub fn router() -> Router<crate::AppState> {
    Router::new().route("/settings/llm", get(get_llm).put(put_llm))
}

#[derive(Debug, Serialize)]
pub struct LlmStatus {
    pub configured: bool,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateLlm {
    /// Empty string or absent leaves the existing key unchanged.
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
}

async fn get_llm(State(llm): State<SharedLlm>) -> Json<LlmStatus> {
    let g = llm.read().await;
    Json(LlmStatus {
        configured: g.configured(),
        base_url: g.base_url.clone(),
        model: g.model.clone(),
    })
}

async fn put_llm(
    State(llm): State<SharedLlm>,
    Json(patch): Json<UpdateLlm>,
) -> Result<Json<LlmStatus>> {
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
}
