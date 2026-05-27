//! Vocabulary CRUD. Each row is owned by a user (`vocab.user_id`) and
//! anchored to either a `material_id` (reader / bookshelf) or an
//! `essay_id` (model-essays library). At least one of the two anchors
//! is required so the row always has a context to point back at.

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use serde::Deserialize;
use sqlx::SqlitePool;

use crate::auth::CurrentUser;
use crate::error::{AppError, Result};
use crate::language::Language;
use crate::models::{CreateVocab, UpdateVocab, Vocab};

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/vocab", get(list).post(create))
        .route("/vocab/:id", get(get_one).put(update).delete(delete_one))
}

const SELECT_COLS: &str = "id, user_id, material_id, essay_id, word, language, kind, lemma, \
    phonetic, pos, definition_zh, definition_en, example_zh, context, mastery, created_at";

#[derive(Debug, Deserialize)]
struct ListQuery {
    material_id: Option<i64>,
    essay_id: Option<i64>,
    kind: Option<String>,
}

async fn list(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<Vocab>>> {
    let kind_filter = q.kind.as_deref().and_then(|k| match k {
        "word" | "idiom" => Some(k),
        _ => None,
    });

    // Build the query incrementally. user_id is always pinned. material_id
    // / essay_id are independent optional filters; kind layers on top.
    let mut sql = format!("SELECT {SELECT_COLS} FROM vocab WHERE user_id = ?");
    if q.material_id.is_some() {
        sql.push_str(" AND material_id = ?");
    }
    if q.essay_id.is_some() {
        sql.push_str(" AND essay_id = ?");
    }
    if kind_filter.is_some() {
        sql.push_str(" AND kind = ?");
    }
    sql.push_str(" ORDER BY created_at DESC");

    let mut query = sqlx::query_as::<_, Vocab>(&sql).bind(user.id);
    if let Some(mid) = q.material_id {
        query = query.bind(mid);
    }
    if let Some(eid) = q.essay_id {
        query = query.bind(eid);
    }
    if let Some(k) = kind_filter {
        query = query.bind(k);
    }
    let rows = query.fetch_all(&pool).await?;
    Ok(Json(rows))
}

async fn get_one(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<Json<Vocab>> {
    let row = sqlx::query_as::<_, Vocab>(&format!(
        "SELECT {SELECT_COLS} FROM vocab WHERE id = ? AND user_id = ?"
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
    // Anchor validation: exactly one of material_id / essay_id, and the
    // referenced row must belong to the current user. We grab the source's
    // language at the same time so a Japanese material's vocab lands in
    // Japanese without the client having to know.
    let (material_id, essay_id, source_language) = resolve_anchor(
        &pool,
        user.id,
        input.material_id,
        input.essay_id,
    )
    .await?;

    let language = input
        .language
        .as_deref()
        .map(Language::normalize)
        .unwrap_or(source_language.as_str());
    let kind = match input.kind.as_deref() {
        Some("idiom") => "idiom",
        _ => "word",
    };

    let row = sqlx::query_as::<_, Vocab>(&format!(
        "INSERT INTO vocab \
         (user_id, material_id, essay_id, word, language, kind, lemma, phonetic, pos, \
          definition_zh, definition_en, example_zh, context, mastery) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         RETURNING {SELECT_COLS}"
    ))
    .bind(user.id)
    .bind(material_id)
    .bind(essay_id)
    .bind(&input.word)
    .bind(language)
    .bind(kind)
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
    let kind = input.kind.as_deref().and_then(|k| match k {
        "word" | "idiom" => Some(k),
        _ => None,
    });
    let row = sqlx::query_as::<_, Vocab>(&format!(
        "UPDATE vocab SET \
           word          = COALESCE(?, word), \
           language      = COALESCE(?, language), \
           kind          = COALESCE(?, kind), \
           lemma         = COALESCE(?, lemma), \
           phonetic      = COALESCE(?, phonetic), \
           pos           = COALESCE(?, pos), \
           definition_zh = COALESCE(?, definition_zh), \
           definition_en = COALESCE(?, definition_en), \
           example_zh    = COALESCE(?, example_zh), \
           context       = COALESCE(?, context), \
           mastery       = COALESCE(?, mastery) \
         WHERE id = ? AND user_id = ? \
         RETURNING {SELECT_COLS}"
    ))
    .bind(input.word)
    .bind(input.language.as_deref().map(Language::normalize))
    .bind(kind)
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
    let result = sqlx::query("DELETE FROM vocab WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound.into());
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Resolve the (material_id, essay_id, language) tuple for an incoming
/// create request. Enforces:
///   - exactly one anchor is set
///   - the anchor belongs to the current user
///   - we return the anchor's own language so the new vocab inherits it
async fn resolve_anchor(
    pool: &SqlitePool,
    user_id: i64,
    material_id: Option<i64>,
    essay_id: Option<i64>,
) -> Result<(Option<i64>, Option<i64>, String)> {
    match (material_id, essay_id) {
        (Some(mid), None) => {
            let language: Option<String> = sqlx::query_scalar(
                "SELECT language FROM materials WHERE id = ? AND user_id = ?",
            )
            .bind(mid)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
            let Some(lang) = language else {
                return Err(AppError(anyhow::anyhow!(
                    "material {mid} not found or not owned by user"
                )));
            };
            Ok((Some(mid), None, lang))
        }
        (None, Some(eid)) => {
            let language: Option<String> = sqlx::query_scalar(
                "SELECT language FROM model_essays WHERE id = ? AND user_id = ?",
            )
            .bind(eid)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
            let Some(lang) = language else {
                return Err(AppError(anyhow::anyhow!(
                    "essay {eid} not found or not owned by user"
                )));
            };
            Ok((None, Some(eid), lang))
        }
        (Some(_), Some(_)) => Err(AppError(anyhow::anyhow!(
            "specify either material_id or essay_id, not both"
        ))),
        (None, None) => Err(AppError(anyhow::anyhow!(
            "one of material_id or essay_id is required"
        ))),
    }
}
