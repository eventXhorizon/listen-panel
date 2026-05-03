use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use serde::Deserialize;
use sqlx::SqlitePool;

use crate::auth::CurrentUser;
use crate::error::Result;
use crate::models::{CreateVocab, UpdateVocab, Vocab};

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/vocab", get(list).post(create))
        .route("/vocab/:id", get(get_one).put(update).delete(delete_one))
}

const SELECT_COLS: &str = "id, material_id, word, lemma, phonetic, pos, \
    definition_zh, definition_en, example_zh, context, mastery, created_at";
const SELECT_COLS_V: &str = "v.id, v.material_id, v.word, v.lemma, v.phonetic, v.pos, \
    v.definition_zh, v.definition_en, v.example_zh, v.context, v.mastery, v.created_at";

#[derive(Debug, Deserialize)]
struct ListQuery {
    material_id: Option<i64>,
}

async fn list(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<Vocab>>> {
    let rows = if let Some(mid) = q.material_id {
        sqlx::query_as::<_, Vocab>(&format!(
            "SELECT {SELECT_COLS_V} FROM vocab v \
             JOIN materials m ON m.id = v.material_id \
             WHERE v.material_id = ? AND m.user_id = ? \
             ORDER BY v.created_at DESC"
        ))
        .bind(mid)
        .bind(user.id)
        .fetch_all(&pool)
        .await?
    } else {
        sqlx::query_as::<_, Vocab>(&format!(
            "SELECT {SELECT_COLS_V} FROM vocab v \
             JOIN materials m ON m.id = v.material_id \
             WHERE m.user_id = ? \
             ORDER BY v.created_at DESC"
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
) -> Result<Json<Vocab>> {
    let row = sqlx::query_as::<_, Vocab>(&format!(
        "SELECT {SELECT_COLS_V} FROM vocab v \
         JOIN materials m ON m.id = v.material_id \
         WHERE v.id = ? AND m.user_id = ?"
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
    Json(input): Json<CreateVocab>,
) -> Result<Json<Vocab>> {
    ensure_material_owner(&pool, input.material_id, user.id).await?;
    let row = sqlx::query_as::<_, Vocab>(&format!(
        "INSERT INTO vocab \
         (material_id, word, lemma, phonetic, pos, \
          definition_zh, definition_en, example_zh, context, mastery) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         RETURNING {SELECT_COLS}"
    ))
    .bind(input.material_id)
    .bind(&input.word)
    .bind(&input.lemma)
    .bind(input.phonetic.as_deref())
    .bind(input.pos.as_deref())
    .bind(&input.definition_zh)
    .bind(input.definition_en.as_deref())
    .bind(input.example_zh.as_deref())
    .bind(&input.context)
    .bind(input.mastery)
    .fetch_one(&pool)
    .await?;
    Ok(Json(row))
}

async fn update(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(input): Json<UpdateVocab>,
) -> Result<Json<Vocab>> {
    let row = sqlx::query_as::<_, Vocab>(&format!(
        "UPDATE vocab SET \
           word          = COALESCE(?, word), \
           lemma         = COALESCE(?, lemma), \
           phonetic      = COALESCE(?, phonetic), \
           pos           = COALESCE(?, pos), \
           definition_zh = COALESCE(?, definition_zh), \
           definition_en = COALESCE(?, definition_en), \
           example_zh    = COALESCE(?, example_zh), \
           context       = COALESCE(?, context), \
           mastery       = COALESCE(?, mastery) \
         WHERE id = ? \
           AND EXISTS ( \
             SELECT 1 FROM materials m \
             WHERE m.id = vocab.material_id AND m.user_id = ? \
           ) \
         RETURNING {SELECT_COLS}"
    ))
    .bind(input.word)
    .bind(input.lemma)
    .bind(input.phonetic)
    .bind(input.pos)
    .bind(input.definition_zh)
    .bind(input.definition_en)
    .bind(input.example_zh)
    .bind(input.context)
    .bind(input.mastery)
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
    let result = sqlx::query(
        "DELETE FROM vocab \
         WHERE id = ? \
           AND EXISTS ( \
             SELECT 1 FROM materials m \
             WHERE m.id = vocab.material_id AND m.user_id = ? \
           )",
    )
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
