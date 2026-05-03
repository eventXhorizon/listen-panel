use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use serde::Deserialize;
use sqlx::SqlitePool;

use crate::error::Result;
use crate::models::{CreateVocab, UpdateVocab, Vocab};

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/vocab", get(list).post(create))
        .route("/vocab/:id", get(get_one).put(update).delete(delete_one))
}

const SELECT_COLS: &str = "id, material_id, word, lemma, phonetic, pos, \
    definition_zh, definition_en, example_zh, context, mastery, created_at";

#[derive(Debug, Deserialize)]
struct ListQuery {
    material_id: Option<i64>,
}

async fn list(
    State(pool): State<SqlitePool>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<Vocab>>> {
    let rows = if let Some(mid) = q.material_id {
        sqlx::query_as::<_, Vocab>(&format!(
            "SELECT {SELECT_COLS} FROM vocab WHERE material_id = ? \
             ORDER BY created_at DESC"
        ))
        .bind(mid)
        .fetch_all(&pool)
        .await?
    } else {
        sqlx::query_as::<_, Vocab>(&format!(
            "SELECT {SELECT_COLS} FROM vocab ORDER BY created_at DESC"
        ))
        .fetch_all(&pool)
        .await?
    };
    Ok(Json(rows))
}

async fn get_one(State(pool): State<SqlitePool>, Path(id): Path<i64>) -> Result<Json<Vocab>> {
    let row = sqlx::query_as::<_, Vocab>(&format!(
        "SELECT {SELECT_COLS} FROM vocab WHERE id = ?"
    ))
    .bind(id)
    .fetch_one(&pool)
    .await?;
    Ok(Json(row))
}

async fn create(
    State(pool): State<SqlitePool>,
    Json(input): Json<CreateVocab>,
) -> Result<Json<Vocab>> {
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
    .fetch_one(&pool)
    .await?;
    Ok(Json(row))
}

async fn delete_one(
    State(pool): State<SqlitePool>,
    Path(id): Path<i64>,
) -> Result<StatusCode> {
    let result = sqlx::query("DELETE FROM vocab WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound.into());
    }
    Ok(StatusCode::NO_CONTENT)
}
