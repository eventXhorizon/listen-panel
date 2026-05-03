mod config;
mod db;
mod error;
mod models;
mod routes;

use anyhow::Result;
use axum::extract::FromRef;
use sqlx::SqlitePool;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::{EnvFilter, fmt};

const ADDR: &str = "0.0.0.0:9527";

#[derive(Clone, FromRef)]
pub struct AppState {
    pub pool: SqlitePool,
    pub http: reqwest::Client,
    pub llm: config::SharedLlm,
}

#[tokio::main]
async fn main() -> Result<()> {
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                EnvFilter::new("info,tower_http=debug,sqlx=warn")
            }),
        )
        .init();

    routes::media::ensure_dirs().await?;
    let pool = db::pool().await?;
    let llm = config::load().await;
    if !llm.read().await.configured() {
        tracing::warn!(
            "DeepSeek API key not set — /api/lookup will fail until configured via /api/settings/llm or web UI"
        );
    }

    let state = AppState {
        pool,
        http: reqwest::Client::new(),
        llm,
    };

    let app = axum::Router::new()
        .nest("/api", routes::api_router(state))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(ADDR).await?;
    tracing::info!("listening on http://{ADDR}");
    axum::serve(listener, app).await?;
    Ok(())
}
