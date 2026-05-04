use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use chrono::Utc;
use serde::Deserialize;
use sqlx::SqlitePool;

use crate::auth::CurrentUser;
use crate::error::Result;
use crate::models::{CreateMaterialNote, MaterialNote, UpdateMaterialNote};

const SELECT_COLS: &str = "id, user_id, material_id, NULL AS material_title, target_type, target_id, paragraph_index, \
    anchor_text, anchor_hash, content, created_at, updated_at";
const SELECT_COLS_WITH_MATERIAL: &str = "n.id, n.user_id, n.material_id, m.title AS material_title, \
    n.target_type, n.target_id, n.paragraph_index, n.anchor_text, n.anchor_hash, n.content, \
    n.created_at, n.updated_at";

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/notes", get(list).post(create))
        .route("/notes/:id", get(get_one).put(update).delete(delete_one))
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    material_id: Option<i64>,
}

async fn list(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<MaterialNote>>> {
    let rows = if let Some(material_id) = q.material_id {
        ensure_material_owner(&pool, material_id, user.id).await?;
        sqlx::query_as::<_, MaterialNote>(&format!(
            "SELECT {SELECT_COLS_WITH_MATERIAL} FROM material_notes n \
             JOIN materials m ON m.id = n.material_id \
             WHERE n.material_id = ? AND n.user_id = ? \
             ORDER BY n.updated_at DESC, n.id DESC"
        ))
        .bind(material_id)
        .bind(user.id)
        .fetch_all(&pool)
        .await?
    } else {
        sqlx::query_as::<_, MaterialNote>(&format!(
            "SELECT {SELECT_COLS_WITH_MATERIAL} FROM material_notes n \
             JOIN materials m ON m.id = n.material_id \
             WHERE n.user_id = ? \
             ORDER BY n.updated_at DESC, n.id DESC"
        ))
        .bind(user.id)
        .fetch_all(&pool)
        .await?
    };
    Ok(Json(rows))
}

async fn get_one(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<Json<MaterialNote>> {
    let row = sqlx::query_as::<_, MaterialNote>(&format!(
        "SELECT {SELECT_COLS_WITH_MATERIAL} FROM material_notes n \
         JOIN materials m ON m.id = n.material_id \
         WHERE n.id = ? AND n.user_id = ?"
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
    Json(input): Json<CreateMaterialNote>,
) -> Result<Json<MaterialNote>> {
    ensure_material_owner(&pool, input.material_id, user.id).await?;
    validate_note_target(&pool, input.material_id, &input).await?;
    let now = Utc::now();

    if let Some(existing_id) = existing_note_id(&pool, user.id, &input).await? {
        let row = sqlx::query_as::<_, MaterialNote>(&format!(
            "UPDATE material_notes SET \
               anchor_text = ?, \
               anchor_hash = ?, \
               content     = ?, \
               updated_at  = ? \
             WHERE id = ? AND user_id = ? \
             RETURNING {SELECT_COLS}"
        ))
        .bind(input.anchor_text.trim())
        .bind(input.anchor_hash.trim())
        .bind(&input.content)
        .bind(now)
        .bind(existing_id)
        .bind(user.id)
        .fetch_one(&pool)
        .await?;
        return Ok(Json(row));
    }

    let row = sqlx::query_as::<_, MaterialNote>(&format!(
        "INSERT INTO material_notes \
         (user_id, material_id, target_type, target_id, paragraph_index, \
          anchor_text, anchor_hash, content, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         RETURNING {SELECT_COLS}"
    ))
    .bind(user.id)
    .bind(input.material_id)
    .bind(&input.target_type)
    .bind(input.target_id)
    .bind(input.paragraph_index)
    .bind(input.anchor_text.trim())
    .bind(input.anchor_hash.trim())
    .bind(&input.content)
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
    Json(input): Json<UpdateMaterialNote>,
) -> Result<Json<MaterialNote>> {
    let now = Utc::now();
    let row = sqlx::query_as::<_, MaterialNote>(&format!(
        "UPDATE material_notes SET \
           anchor_text = COALESCE(?, anchor_text), \
           anchor_hash = COALESCE(?, anchor_hash), \
           content     = COALESCE(?, content), \
           updated_at  = ? \
         WHERE id = ? AND user_id = ? \
         RETURNING {SELECT_COLS}"
    ))
    .bind(input.anchor_text.map(|v| v.trim().to_string()))
    .bind(input.anchor_hash.map(|v| v.trim().to_string()))
    .bind(input.content)
    .bind(now)
    .bind(id)
    .bind(user.id)
    .fetch_one(&pool)
    .await?;
    Ok(Json(row))
}

async fn delete_one(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode> {
    let result = sqlx::query("DELETE FROM material_notes WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound.into());
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn ensure_material_owner(pool: &SqlitePool, material_id: i64, user_id: i64) -> Result<()> {
    let exists: Option<i64> =
        sqlx::query_scalar("SELECT id FROM materials WHERE id = ? AND user_id = ?")
            .bind(material_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    if exists.is_none() {
        return Err(sqlx::Error::RowNotFound.into());
    }
    Ok(())
}

async fn existing_note_id(
    pool: &SqlitePool,
    user_id: i64,
    input: &CreateMaterialNote,
) -> Result<Option<i64>> {
    let id = match input.target_type.as_str() {
        "paragraph" => {
            sqlx::query_scalar(
                "SELECT id FROM material_notes \
                 WHERE user_id = ? AND material_id = ? AND target_type = 'paragraph' \
                   AND paragraph_index = ?",
            )
            .bind(user_id)
            .bind(input.material_id)
            .bind(input.paragraph_index)
            .fetch_optional(pool)
            .await?
        }
        "segment" => {
            sqlx::query_scalar(
                "SELECT id FROM material_notes \
                 WHERE user_id = ? AND material_id = ? AND target_type = 'segment' \
                   AND target_id = ?",
            )
            .bind(user_id)
            .bind(input.material_id)
            .bind(input.target_id)
            .fetch_optional(pool)
            .await?
        }
        _ => None,
    };
    Ok(id)
}

async fn validate_note_target(
    pool: &SqlitePool,
    material_id: i64,
    input: &CreateMaterialNote,
) -> Result<()> {
    match input.target_type.as_str() {
        "paragraph" => {
            if !matches!(input.paragraph_index, Some(index) if index >= 0) {
                return Err(anyhow::anyhow!("paragraph note requires paragraph_index").into());
            }
        }
        "segment" => {
            let Some(segment_id) = input.target_id else {
                return Err(anyhow::anyhow!("segment note requires target_id").into());
            };
            let exists: Option<i64> = sqlx::query_scalar(
                "SELECT id FROM transcript_segments WHERE id = ? AND material_id = ?",
            )
            .bind(segment_id)
            .bind(material_id)
            .fetch_optional(pool)
            .await?;
            if exists.is_none() {
                return Err(sqlx::Error::RowNotFound.into());
            }
        }
        _ => {
            return Err(anyhow::anyhow!("unsupported note target type").into());
        }
    }
    Ok(())
}
