mod access;
mod auth;
mod config;
mod db;
mod error;
mod furigana;
mod language;
mod llm_call;
mod logbuf;
mod models;
mod news_fetcher;
mod paths;
mod routes;
mod study;
mod youtube;

use std::time::Duration;

use anyhow::Result;
use axum::extract::FromRef;
use sqlx::SqlitePool;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer, fmt};

const ADDR: &str = "0.0.0.0:9527";

#[derive(Clone, FromRef)]
pub struct AppState {
    pub pool: SqlitePool,
    pub http: reqwest::Client,
    pub llm: config::SharedLlm,
    pub tts: config::SharedTts,
    pub asr: config::SharedAsr,
    pub features: config::SharedFeatures,
    pub logs: logbuf::LogBuffer,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Keep the tail of the log in memory so the 日志 page can show what the
    // server has been doing. INFO and above only — tower_http's per-request
    // debug lines carry span state the page can't render, so requests are
    // logged deliberately by `access` instead.
    let log_buffer = logbuf::LogBuffer::new(2000);
    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,tower_http=debug,sqlx=warn")),
        )
        .with(fmt::layer())
        .with(logbuf::LogLayer::new(log_buffer.clone()).with_filter(LevelFilter::INFO))
        .init();

    paths::init()?;
    routes::media::ensure_dirs().await?;
    routes::tts::ensure_cache_dir().await?;
    let pool = db::pool().await?;
    routes::interview::seed_system_questions(&pool).await?;
    let llm = config::load().await;
    if !llm.read().await.configured() {
        tracing::warn!(
            "DeepSeek API key not set — /api/lookup will fail until configured via /api/settings/llm or web UI"
        );
    }
    let tts = config::load_tts().await;
    if !tts.read().await.configured() {
        tracing::warn!(
            "TTS API key not set — /api/tts/speech will fail until configured via /api/settings/tts or web UI"
        );
    }
    let asr = config::load_asr().await;
    if !asr.read().await.configured() {
        tracing::warn!(
            "ASR worker base URL not set — transcription jobs will fail until configured via /api/settings/asr or web UI"
        );
    }

    let features = config::load_features().await;

    let state = AppState {
        pool,
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()?,
        llm,
        tts,
        asr,
        features,
        logs: log_buffer,
    };

    let youtube_api_key = std::env::var("YOUTUBE_API_KEY").unwrap_or_default();
    news_fetcher::spawn(
        state.pool.clone(),
        state.http.clone(),
        state.llm.clone(),
        youtube_api_key,
    );

    let app = axum::Router::new()
        .merge(routes::health::router(state.pool.clone()))
        .nest("/api", routes::api_router(state))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        // Outermost, so the recorded status and duration are what the client
        // actually saw.
        .layer(axum::middleware::from_fn(access::log_requests));

    let listener = tokio::net::TcpListener::bind(ADDR).await?;
    tracing::info!("listening on http://{ADDR}");
    axum::serve(listener, app).await?;
    Ok(())
}
