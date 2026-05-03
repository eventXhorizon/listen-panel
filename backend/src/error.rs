use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug)]
pub struct AppError(pub anyhow::Error);

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        Self(err.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let mut status = StatusCode::INTERNAL_SERVER_ERROR;

        if let Some(sqlx_err) = self.0.downcast_ref::<sqlx::Error>() {
            if matches!(sqlx_err, sqlx::Error::RowNotFound) {
                status = StatusCode::NOT_FOUND;
            }
        }

        let msg = format!("{:#}", self.0);
        tracing::error!(status = %status, "{msg}");
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
