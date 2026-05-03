use std::time::Duration;

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use axum::Json;
use axum::async_trait;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{Duration as ChronoDuration, Utc};
use cookie::{Cookie, SameSite};
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::error::{AppError, Result};

pub const SESSION_COOKIE: &str = "listen_panel_session";
const SESSION_DAYS: i64 = 30;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct CurrentUser {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub is_admin: bool,
}

#[derive(Debug, Clone)]
pub struct OptionalUser(pub Option<CurrentUser>);

pub fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = argon2()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("failed to hash password: {e}"))?
        .to_string();
    Ok(hash)
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    argon2()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

fn argon2() -> Argon2<'static> {
    Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::default())
}

pub fn new_session_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn token_hash(token: &str) -> String {
    let hash = Sha256::digest(token.as_bytes());
    format!("{hash:x}")
}

pub async fn create_session(pool: &SqlitePool, user_id: i64) -> Result<String> {
    let token = new_session_token();
    let hash = token_hash(&token);
    let now = Utc::now();
    let expires = now + ChronoDuration::days(SESSION_DAYS);
    sqlx::query(
        "INSERT INTO sessions (user_id, token_hash, created_at, expires_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(hash)
    .bind(now)
    .bind(expires)
    .execute(pool)
    .await?;
    Ok(token)
}

pub async fn delete_session(pool: &SqlitePool, token: &str) -> Result<()> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
        .bind(token_hash(token))
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn user_from_headers(
    pool: &SqlitePool,
    headers: &HeaderMap,
) -> Result<Option<CurrentUser>> {
    let Some(token) = cookie_token(headers) else {
        return Ok(None);
    };
    let hash = token_hash(&token);
    let user = sqlx::query_as::<_, CurrentUser>(
        "SELECT u.id, u.username, u.display_name, u.is_admin \
         FROM sessions s \
         JOIN users u ON u.id = s.user_id \
         WHERE s.token_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(hash)
    .fetch_optional(pool)
    .await?;
    Ok(user)
}

pub fn cookie_token(headers: &HeaderMap) -> Option<String> {
    let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in cookie.split(';') {
        if let Ok(parsed) = Cookie::parse(part.trim().to_string()) {
            if parsed.name() == SESSION_COOKIE {
                return Some(parsed.value().to_string());
            }
        }
    }
    None
}

pub fn session_cookie(token: &str) -> String {
    Cookie::build((SESSION_COOKIE, token.to_string()))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(cookie::time::Duration::seconds(
            Duration::from_secs((SESSION_DAYS * 24 * 60 * 60) as u64).as_secs() as i64,
        ))
        .to_string()
}

pub fn clear_session_cookie() -> String {
    Cookie::build((SESSION_COOKIE, ""))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(cookie::time::Duration::seconds(0))
        .to_string()
}

pub fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": "authentication required" })),
    )
        .into_response()
}

pub fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({ "error": "admin required" })),
    )
        .into_response()
}

#[async_trait]
impl FromRequestParts<crate::AppState> for CurrentUser {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &crate::AppState,
    ) -> std::result::Result<Self, Self::Rejection> {
        match user_from_headers(&state.pool, &parts.headers).await {
            Ok(Some(user)) => Ok(user),
            Ok(None) => Err(unauthorized()),
            Err(e) => Err(AppError(e.0).into_response()),
        }
    }
}

#[async_trait]
impl FromRequestParts<crate::AppState> for OptionalUser {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &crate::AppState,
    ) -> std::result::Result<Self, Self::Rejection> {
        match user_from_headers(&state.pool, &parts.headers).await {
            Ok(user) => Ok(Self(user)),
            Err(e) => Err(AppError(e.0).into_response()),
        }
    }
}
