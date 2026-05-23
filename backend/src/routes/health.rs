//! Liveness + readiness probe at `GET /health`.
//!
//! Mounted at the root (not under `/api`) so external probes — Docker HEALTHCHECK,
//! load balancers, Cloudflare uptime — don't need to know the API prefix.
//!
//! Returns 200 when the DB pool can acquire a connection, 503 otherwise.

use axum::{Router, extract::State, http::StatusCode, response::IntoResponse, routing::get};
use serde_json::json;
use sqlx::SqlitePool;

pub fn router(pool: SqlitePool) -> Router {
    Router::new().route("/health", get(health)).with_state(pool)
}

async fn health(State(pool): State<SqlitePool>) -> impl IntoResponse {
    match pool.acquire().await {
        Ok(_) => (StatusCode::OK, axum::Json(json!({ "status": "ok" }))),
        Err(e) => {
            tracing::warn!("health check: db acquire failed: {e:#}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(json!({ "status": "db_unavailable" })),
            )
        }
    }
}
