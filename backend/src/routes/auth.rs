use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::auth::{self, CurrentUser, OptionalUser};
use crate::error::Result;

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/auth/status", get(status))
        .route("/auth/setup", post(setup))
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
}

#[derive(Debug, Serialize)]
struct AuthStatus {
    needs_setup: bool,
    user: Option<CurrentUser>,
}

#[derive(Debug, Deserialize)]
struct SetupInput {
    username: String,
    display_name: Option<String>,
    password: String,
}

#[derive(Debug, Deserialize)]
struct LoginInput {
    username: String,
    password: String,
}

#[derive(Debug, sqlx::FromRow)]
struct LoginUser {
    id: i64,
    password_hash: String,
}

async fn status(
    State(pool): State<SqlitePool>,
    OptionalUser(user): OptionalUser,
) -> Result<Json<AuthStatus>> {
    Ok(Json(AuthStatus {
        needs_setup: user_count(&pool).await? == 0,
        user,
    }))
}

async fn setup(State(pool): State<SqlitePool>, Json(input): Json<SetupInput>) -> Result<Response> {
    if user_count(&pool).await? > 0 {
        return Ok((
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "setup already completed" })),
        )
            .into_response());
    }
    let username = match normalize_username(&input.username) {
        Ok(v) => v,
        Err(response) => return Ok(response),
    };
    if let Err(response) = validate_password(&input.password) {
        return Ok(response);
    }
    let display_name = input
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&username)
        .to_string();
    let password_hash = auth::hash_password(&input.password)?;

    let mut tx = pool.begin().await?;
    let user_id: i64 = sqlx::query_scalar(
        "INSERT INTO users (username, display_name, password_hash, is_admin) \
         VALUES (?, ?, ?, 1) \
         RETURNING id",
    )
    .bind(&username)
    .bind(&display_name)
    .bind(password_hash)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("UPDATE materials SET user_id = ? WHERE user_id IS NULL")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT OR IGNORE INTO uploads (file, user_id) \
         SELECT source_ref, ? FROM materials \
         WHERE source_type = 'local' AND source_ref <> '' AND user_id = ?",
    )
    .bind(user_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    respond_with_session(&pool, user_id).await
}

async fn register(
    State(pool): State<SqlitePool>,
    Json(input): Json<SetupInput>,
) -> Result<Response> {
    if user_count(&pool).await? == 0 {
        return Ok((
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "setup required first" })),
        )
            .into_response());
    }
    let username = match normalize_username(&input.username) {
        Ok(v) => v,
        Err(response) => return Ok(response),
    };
    if let Err(response) = validate_password(&input.password) {
        return Ok(response);
    }
    let display_name = input
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&username)
        .to_string();
    let password_hash = auth::hash_password(&input.password)?;

    let user_id: i64 = match sqlx::query_scalar(
        "INSERT INTO users (username, display_name, password_hash, is_admin) \
         VALUES (?, ?, ?, 0) \
         RETURNING id",
    )
    .bind(&username)
    .bind(&display_name)
    .bind(password_hash)
    .fetch_one(&pool)
    .await
    {
        Ok(id) => id,
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
            return Ok((
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": "username already exists" })),
            )
                .into_response());
        }
        Err(e) => return Err(e.into()),
    };

    respond_with_session(&pool, user_id).await
}

async fn login(State(pool): State<SqlitePool>, Json(input): Json<LoginInput>) -> Result<Response> {
    let username = match normalize_username(&input.username) {
        Ok(v) => v,
        Err(_) => return Ok(invalid_login()),
    };
    let row =
        sqlx::query_as::<_, LoginUser>("SELECT id, password_hash FROM users WHERE username = ?")
            .bind(username)
            .fetch_optional(&pool)
            .await?;
    let Some(user) = row else {
        return Ok(invalid_login());
    };
    if !auth::verify_password(&input.password, &user.password_hash) {
        return Ok(invalid_login());
    }
    respond_with_session(&pool, user.id).await
}

async fn logout(State(pool): State<SqlitePool>, headers: HeaderMap) -> Result<Response> {
    if let Some(token) = auth::cookie_token(&headers) {
        auth::delete_session(&pool, &token).await?;
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&auth::clear_session_cookie())?,
    );
    Ok((headers, StatusCode::NO_CONTENT).into_response())
}

async fn respond_with_session(pool: &SqlitePool, user_id: i64) -> Result<Response> {
    let token = auth::create_session(pool, user_id).await?;
    let user = sqlx::query_as::<_, CurrentUser>(
        "SELECT id, username, display_name, is_admin FROM users WHERE id = ?",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&auth::session_cookie(&token))?,
    );
    Ok((headers, Json(user)).into_response())
}

async fn user_count(pool: &SqlitePool) -> Result<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await?)
}

fn normalize_username(username: &str) -> std::result::Result<String, Response> {
    let normalized = username.trim().to_lowercase();
    let valid = normalized.len() >= 3
        && normalized.len() <= 32
        && normalized
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "username must be 3-32 chars: letters, numbers, underscore, hyphen"
            })),
        )
            .into_response());
    }
    Ok(normalized)
}

fn validate_password(password: &str) -> std::result::Result<(), Response> {
    if password.len() < 8 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "password must be at least 8 characters"
            })),
        )
            .into_response());
    }
    Ok(())
}

fn invalid_login() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": "invalid username or password" })),
    )
        .into_response()
}
