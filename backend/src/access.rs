//! One log line per API request.
//!
//! Without this the 日志 page sits empty between TTS/ASR jobs and reads as
//! broken. An access line per request gives it a pulse — and answers "which
//! call was slow / which one 500'd" without reaching for `docker logs`.

use std::time::Instant;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;

/// Paths worth staying quiet about. The Docker health probe fires every 30s and
/// would roll the ring buffer on its own, and logging the log endpoints means
/// merely watching the 日志 page generates entries about watching it.
fn skip(path: &str) -> bool {
    path == "/health" || path.starts_with("/api/logs")
}

pub async fn log_requests(req: Request, next: Next) -> Response {
    // Query strings can carry tokens, so only the path is recorded.
    let path = req.uri().path().to_string();
    if skip(&path) {
        return next.run(req).await;
    }
    let method = req.method().clone();

    let started = Instant::now();
    let response = next.run(req).await;
    let status = response.status().as_u16();
    let ms = started.elapsed().as_millis();

    // Level tracks the status code so the page's ERROR/WARN filters are useful.
    match status {
        500..=599 => tracing::error!(target: "http", "{method} {path} {status} {ms}ms"),
        400..=499 => tracing::warn!(target: "http", "{method} {path} {status} {ms}ms"),
        _ => tracing::info!(target: "http", "{method} {path} {status} {ms}ms"),
    }
    response
}
