use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use chrono::Utc;
use sqlx::SqlitePool;

use crate::auth::CurrentUser;
use crate::error::Result;
use crate::models::{CreateMaterial, Material, UpdateMaterial};

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/materials", get(list).post(create))
        .route(
            "/materials/:id",
            get(get_one).put(update).delete(delete_one),
        )
}

const SELECT_COLS: &str =
    "id, user_id, title, source_type, source_ref, text, notes, created_at, updated_at";

async fn list(State(pool): State<SqlitePool>, user: CurrentUser) -> Result<Json<Vec<Material>>> {
    let rows = sqlx::query_as::<_, Material>(&format!(
        "SELECT {SELECT_COLS} FROM materials \
         WHERE user_id = ? \
         ORDER BY updated_at DESC"
    ))
    .bind(user.id)
    .fetch_all(&pool)
    .await?;
    Ok(Json(rows))
}

async fn get_one(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<Json<Material>> {
    let row = sqlx::query_as::<_, Material>(&format!(
        "SELECT {SELECT_COLS} FROM materials WHERE id = ? AND user_id = ?"
    ))
    .bind(id)
    .bind(user.id)
    .fetch_one(&pool)
    .await?;
    Ok(Json(row))
}

async fn create(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Json(input): Json<CreateMaterial>,
) -> Result<Json<Material>> {
    if input.source_type == "local" {
        crate::routes::media::ensure_upload_owner(&pool, &input.source_ref, user.id).await?;
    }

    let now = Utc::now();
    let row = sqlx::query_as::<_, Material>(&format!(
        "INSERT INTO materials \
         (user_id, title, source_type, source_ref, text, notes, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
         RETURNING {SELECT_COLS}"
    ))
    .bind(user.id)
    .bind(&input.title)
    .bind(&input.source_type)
    .bind(&input.source_ref)
    .bind(&input.text)
    .bind(&input.notes)
    .bind(now)
    .bind(now)
    .fetch_one(&pool)
    .await?;
    Ok(Json(row))
}

async fn update(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(input): Json<UpdateMaterial>,
) -> Result<Json<Material>> {
    let old = sqlx::query_as::<_, Material>(&format!(
        "SELECT {SELECT_COLS} FROM materials WHERE id = ? AND user_id = ?"
    ))
    .bind(id)
    .bind(user.id)
    .fetch_one(&pool)
    .await?;

    let next_source_type = input.source_type.as_deref().unwrap_or(&old.source_type);
    let next_source_ref = input.source_ref.as_deref().unwrap_or(&old.source_ref);
    if next_source_type == "local"
        && (old.source_type != "local" || next_source_ref != old.source_ref)
    {
        crate::routes::media::ensure_upload_owner(&pool, next_source_ref, user.id).await?;
    }

    let now = Utc::now();
    let row = sqlx::query_as::<_, Material>(&format!(
        "UPDATE materials SET \
           title       = COALESCE(?, title), \
           source_type = COALESCE(?, source_type), \
           source_ref  = COALESCE(?, source_ref), \
           text        = COALESCE(?, text), \
           notes       = COALESCE(?, notes), \
           updated_at  = ? \
         WHERE id = ? \
           AND user_id = ? \
         RETURNING {SELECT_COLS}"
    ))
    .bind(input.title)
    .bind(input.source_type)
    .bind(input.source_ref)
    .bind(input.text)
    .bind(input.notes)
    .bind(now)
    .bind(id)
    .bind(user.id)
    .fetch_one(&pool)
    .await?;

    if old.source_type == "local"
        && (row.source_type != "local" || row.source_ref != old.source_ref)
    {
        crate::routes::media::delete_upload_if_orphan(&pool, &old.source_ref).await;
    }

    Ok(Json(row))
}

async fn delete_one(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode> {
    let old = sqlx::query_as::<_, Material>(&format!(
        "SELECT {SELECT_COLS} FROM materials WHERE id = ? AND user_id = ?"
    ))
    .bind(id)
    .bind(user.id)
    .fetch_optional(&pool)
    .await?;

    let result = sqlx::query("DELETE FROM materials WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound.into());
    }

    if let Some(m) = old {
        if m.source_type == "local" {
            crate::routes::media::delete_upload_if_orphan(&pool, &m.source_ref).await;
        }
    }

    Ok(StatusCode::NO_CONTENT)
}
