use std::convert::Infallible;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

use crate::auth::{self, CurrentUser};
use crate::logbuf::{LogBuffer, LogEntry};

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/logs", get(list))
        .route("/logs/stream", get(stream))
        .route("/logs/event", post(event))
}

const DEFAULT_LIMIT: usize = 300;
const MAX_LIMIT: usize = 2000;
/// How much history a newly opened stream replays before going live.
const BACKLOG: usize = 500;

#[derive(Debug, Deserialize)]
struct LogQuery {
    limit: Option<usize>,
}

/// One-shot tail of the server log. Admin-only: log lines name upstream
/// services and can echo request details, so they aren't for every account.
async fn list(
    State(logs): State<LogBuffer>,
    user: CurrentUser,
    Query(q): Query<LogQuery>,
) -> Response {
    if !user.is_admin {
        return auth::forbidden();
    }
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    Json(logs.snapshot(limit)).into_response()
}

/// Live tail over Server-Sent Events: replays recent history, then pushes each
/// new line as it is logged.
///
/// Subscribing *before* taking the snapshot means no line can slip through the
/// gap between the two. That can duplicate a line or two across the seam, which
/// is harmless — every entry carries a `seq` the client dedupes on.
async fn stream(State(logs): State<LogBuffer>, user: CurrentUser) -> Response {
    if !user.is_admin {
        return auth::forbidden();
    }

    let live = BroadcastStream::new(logs.subscribe());
    let backlog = tokio_stream::iter(logs.snapshot(BACKLOG));

    // A lagging client only loses the lines it was too slow to read; keep the
    // stream alive rather than dropping the connection.
    let events = backlog
        .chain(live.filter_map(|res| res.ok()))
        .map(|entry| Ok::<_, Infallible>(sse_event(&entry)));

    Sse::new(events)
        .keep_alive(KeepAlive::default())
        .into_response()
}

/// Longest client message kept, counted in characters so multi-byte titles are
/// never cut mid-character.
const MAX_EVENT_CHARS: usize = 300;

#[derive(Debug, Deserialize)]
struct EventInput {
    message: String,
}

/// Records a browser-side action in the same log.
///
/// Anything the user does purely in the page — hitting play on audio the
/// browser already buffered — produces no request of its own, so it would be
/// invisible in an access log. Any signed-in user may post: the point is to see
/// study activity, not just admin activity.
async fn event(user: CurrentUser, Json(input): Json<EventInput>) -> Response {
    // Newlines would forge extra log lines; the char take bounds the size.
    let message: String = input
        .message
        .replace(['\n', '\r'], " ")
        .chars()
        .take(MAX_EVENT_CHARS)
        .collect();
    if message.trim().is_empty() {
        return StatusCode::NO_CONTENT.into_response();
    }
    tracing::info!(target: "client", "[{}] {message}", user.username);
    StatusCode::NO_CONTENT.into_response()
}

fn sse_event(entry: &LogEntry) -> Event {
    Event::default()
        .json_data(entry)
        .unwrap_or_else(|_| Event::default().data("{}"))
}
