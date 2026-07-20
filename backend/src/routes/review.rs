//! Spaced repetition over vocab and the articles it came from.
//!
//! The schedule follows a fixed Ebbinghaus ladder rather than an adaptive
//! scheme: the intervals are the point of the exercise and stay explainable
//! ("you got this right twice, so it's back in 4 days").
//!
//! Enrolment is implicit. Adding a word to your vocab is the signal that you
//! studied it, and that you studied the article it came from -- so both are
//! swept into the schedule by [`sync`], which every queue fetch runs. Doing it
//! there rather than at vocab-creation time keeps the many places that create
//! vocab unaware of review, and picks up rows that predate this feature.

use axum::extract::{Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::auth::CurrentUser;
use crate::error::{AppError, Result};

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/review/queue", get(queue))
        .route("/review/summary", get(summary))
        .route("/review/grade", post(grade))
}

/// Days between reviews, by rung. Recalling correctly climbs one rung, failing
/// drops to the bottom. The last rung repeats for anything long-since learned.
const LADDER: [i64; 7] = [1, 2, 4, 7, 15, 30, 60];

/// How much lands on one day. Without a cap the first session would serve the
/// entire backlog at once (169 words and counting), which is how review habits
/// die; the rest simply waits, oldest first.
const DAILY_VOCAB: usize = 30;
const DAILY_ARTICLES: usize = 3;

/// BBC imports are stamped with this in `materials.notes`. The review page
/// splits on it so a day's practice can be aimed at one shelf or the other.
const BBC_MARK: &str = "BBC 6 Minute English%";

// --------------------------------------------------------------------------- //
// Wire types
// --------------------------------------------------------------------------- //

#[derive(Debug, Deserialize)]
struct TodayQuery {
    /// The client's local date. The server runs UTC, so it cannot work this
    /// out itself without handing a JST user tomorrow's queue at 09:00.
    today: String,
}

#[derive(Debug, Deserialize)]
struct QueueQuery {
    today: String,
    /// Which shelf to practise. The daily cap applies *within* a shelf: a
    /// global cap filled by whichever rows sorted first would leave one tab
    /// showing a due count next to an empty list.
    scope: Option<String>,
}

/// SQL fragment that labels a row's shelf, given `m` bound to its material.
fn scope_expr() -> String {
    format!("CASE WHEN m.notes LIKE '{BBC_MARK}' THEN 'bbc' ELSE 'mine' END")
}

fn parse_scope(scope: Option<&str>) -> Result<Option<&str>> {
    match scope {
        None | Some("") | Some("all") => Ok(None),
        Some(s @ ("bbc" | "mine")) => Ok(Some(s)),
        Some(other) => Err(AppError(anyhow::anyhow!("unknown scope {other:?}"))),
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct VocabCard {
    schedule_id: i64,
    id: i64,
    word: String,
    kind: String,
    lemma: String,
    phonetic: Option<String>,
    definition_zh: String,
    definition_en: Option<String>,
    context: String,
    material_id: Option<i64>,
    material_title: Option<String>,
    scope: String,
    step: i64,
    reviews: i64,
    due_on: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct ArticleCard {
    schedule_id: i64,
    id: i64,
    title: String,
    scope: String,
    vocab_count: i64,
    step: i64,
    reviews: i64,
    due_on: String,
}

#[derive(Debug, Serialize)]
struct Queue {
    vocab: Vec<VocabCard>,
    articles: Vec<ArticleCard>,
    counts: Counts,
}

/// Everything the page needs to say "30 of 169 today, 12 from BBC".
#[derive(Debug, Default, Serialize)]
struct Counts {
    due_vocab: i64,
    due_articles: i64,
    serving_vocab: i64,
    serving_articles: i64,
    bbc_vocab: i64,
    mine_vocab: i64,
    bbc_articles: i64,
    mine_articles: i64,
    scheduled_total: i64,
}

#[derive(Debug, Deserialize)]
struct GradeInput {
    schedule_id: i64,
    /// Did the user recall it? Anything finer would need an adaptive scheme.
    ok: bool,
    today: String,
}

#[derive(Debug, Serialize)]
struct GradeResult {
    step: i64,
    due_on: String,
    interval_days: i64,
}

// --------------------------------------------------------------------------- //
// Dates
// --------------------------------------------------------------------------- //

/// Parse the client's date. Rejecting a malformed one matters: it is compared
/// as a string against stored dates, so "7/20/2026" would silently order wrong
/// and either flood the queue or empty it.
fn parse_today(today: &str) -> Result<chrono::NaiveDate> {
    chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d")
        .map_err(|_| AppError(anyhow::anyhow!("today must be YYYY-MM-DD, got {today:?}")))
}

fn add_days(date: chrono::NaiveDate, days: i64) -> String {
    (date + chrono::Duration::days(days))
        .format("%Y-%m-%d")
        .to_string()
}

// --------------------------------------------------------------------------- //
// Enrolment
// --------------------------------------------------------------------------- //

/// Give every vocab entry, and every article a vocab entry came from, a
/// schedule row due today. `INSERT OR IGNORE` against the unique indexes makes
/// this safe to run on every request.
///
/// Articles are keyed off vocab rather than any "opened it" signal on purpose:
/// with 887 imported BBC episodes, anything looser would bury the queue under
/// material the user never actually studied.
async fn sync(pool: &SqlitePool, user_id: i64, today: &str) -> Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO review_schedule (user_id, kind, vocab_id, due_on)
         SELECT user_id, 'vocab', id, ? FROM vocab WHERE user_id = ?",
    )
    .bind(today)
    .bind(user_id)
    .execute(pool)
    .await?;

    sqlx::query(
        "INSERT OR IGNORE INTO review_schedule (user_id, kind, material_id, due_on)
         SELECT DISTINCT ?, 'material', material_id, ?
         FROM vocab WHERE user_id = ? AND material_id IS NOT NULL",
    )
    .bind(user_id)
    .bind(today)
    .bind(user_id)
    .execute(pool)
    .await?;

    Ok(())
}

// --------------------------------------------------------------------------- //
// Handlers
// --------------------------------------------------------------------------- //

/// Today's practice: the oldest-due vocab and articles, capped for the day.
async fn queue(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Query(q): Query<QueueQuery>,
) -> Result<Json<Queue>> {
    parse_today(&q.today)?;
    let scope = parse_scope(q.scope.as_deref())?;
    sync(&pool, user.id, &q.today).await?;

    let scope_sql = scope_expr();
    let scope_filter = if scope.is_some() {
        format!(" AND {scope_sql} = ?")
    } else {
        String::new()
    };

    // Held in a binding: sqlx borrows the SQL for the life of the query
    // builder, so a temporary from format!() would be dropped too early.
    let vocab_sql = format!(
        "SELECT s.id AS schedule_id, v.id, v.word, v.kind, v.lemma, v.phonetic,
                v.definition_zh, v.definition_en, v.context,
                v.material_id, m.title AS material_title,
                {scope_sql} AS scope,
                s.step, s.reviews, s.due_on
         FROM review_schedule s
         JOIN vocab v ON v.id = s.vocab_id
         LEFT JOIN materials m ON m.id = v.material_id
         WHERE s.user_id = ? AND s.kind = 'vocab' AND s.due_on <= ?{scope_filter}
         ORDER BY s.due_on ASC, s.id ASC
         LIMIT ?"
    );
    let mut vocab_q = sqlx::query_as::<_, VocabCard>(&vocab_sql)
        .bind(user.id)
        .bind(&q.today);
    if let Some(s) = scope {
        vocab_q = vocab_q.bind(s);
    }
    let vocab = vocab_q.bind(DAILY_VOCAB as i64).fetch_all(&pool).await?;

    let articles_sql = format!(
        "SELECT s.id AS schedule_id, m.id, m.title,
                {scope_sql} AS scope,
                (SELECT COUNT(*) FROM vocab v
                  WHERE v.material_id = m.id AND v.user_id = s.user_id) AS vocab_count,
                s.step, s.reviews, s.due_on
         FROM review_schedule s
         JOIN materials m ON m.id = s.material_id
         WHERE s.user_id = ? AND s.kind = 'material' AND s.due_on <= ?{scope_filter}
         ORDER BY s.due_on ASC, s.id ASC
         LIMIT ?"
    );
    let mut articles_q = sqlx::query_as::<_, ArticleCard>(&articles_sql)
        .bind(user.id)
        .bind(&q.today);
    if let Some(s) = scope {
        articles_q = articles_q.bind(s);
    }
    let articles = articles_q
        .bind(DAILY_ARTICLES as i64)
        .fetch_all(&pool)
        .await?;

    let counts = tally(&pool, user.id, &q.today).await?;
    Ok(Json(Queue {
        counts: Counts {
            serving_vocab: vocab.len() as i64,
            serving_articles: articles.len() as i64,
            ..counts
        },
        vocab,
        articles,
    }))
}

/// Just the numbers, for the nav badge — no card payloads.
async fn summary(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Query(q): Query<TodayQuery>,
) -> Result<Json<Counts>> {
    parse_today(&q.today)?;
    sync(&pool, user.id, &q.today).await?;
    let mut counts = tally(&pool, user.id, &q.today).await?;
    counts.serving_vocab = counts.due_vocab.min(DAILY_VOCAB as i64);
    counts.serving_articles = counts.due_articles.min(DAILY_ARTICLES as i64);
    Ok(Json(counts))
}

async fn tally(pool: &SqlitePool, user_id: i64, today: &str) -> Result<Counts> {
    // A vocab card's shelf is the shelf of the article it came from, so both
    // kinds resolve through the same materials join via COALESCE.
    let row: (i64, i64, i64, i64, i64, i64, i64) = sqlx::query_as(&format!(
        "WITH due AS (
           SELECT s.kind AS kind,
                  CASE WHEN m.notes LIKE '{BBC_MARK}' THEN 1 ELSE 0 END AS is_bbc
           FROM review_schedule s
           LEFT JOIN vocab v     ON v.id = s.vocab_id
           LEFT JOIN materials m ON m.id = COALESCE(s.material_id, v.material_id)
           WHERE s.user_id = ? AND s.due_on <= ?
         )
         SELECT
           COALESCE(SUM(kind = 'vocab'), 0),
           COALESCE(SUM(kind = 'material'), 0),
           COALESCE(SUM(kind = 'vocab'    AND is_bbc), 0),
           COALESCE(SUM(kind = 'vocab'    AND NOT is_bbc), 0),
           COALESCE(SUM(kind = 'material' AND is_bbc), 0),
           COALESCE(SUM(kind = 'material' AND NOT is_bbc), 0),
           (SELECT COUNT(*) FROM review_schedule WHERE user_id = ?)
         FROM due"
    ))
    .bind(user_id)
    .bind(today)
    .bind(user_id)
    .fetch_one(pool)
    .await?;

    Ok(Counts {
        due_vocab: row.0,
        due_articles: row.1,
        bbc_vocab: row.2,
        mine_vocab: row.3,
        bbc_articles: row.4,
        mine_articles: row.5,
        scheduled_total: row.6,
        ..Default::default()
    })
}

/// Move one item along the ladder.
async fn grade(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Json(input): Json<GradeInput>,
) -> Result<Json<GradeResult>> {
    let today = parse_today(&input.today)?;

    let step: i64 = sqlx::query_scalar(
        "SELECT step FROM review_schedule WHERE id = ? AND user_id = ?",
    )
    .bind(input.schedule_id)
    .bind(user.id)
    .fetch_one(&pool)
    .await?;

    // The interval comes from the rung the item is *on*, and only then does it
    // climb. Reading the next rung instead would make a brand-new card wait 2
    // days for its first review and leave the 1-day rung reachable only by
    // getting something wrong.
    let top = LADDER.len() as i64 - 1;
    let (next_step, interval) = if input.ok {
        (
            (step + 1).min(top),
            LADDER[step.clamp(0, top) as usize],
        )
    } else {
        (0, LADDER[0])
    };
    let due_on = add_days(today, interval);

    sqlx::query(
        "UPDATE review_schedule
            SET step = ?, due_on = ?, last_review = ?,
                reviews = reviews + 1,
                lapses = lapses + ?
          WHERE id = ? AND user_id = ?",
    )
    .bind(next_step)
    .bind(&due_on)
    .bind(input.today)
    .bind(i64::from(!input.ok))
    .bind(input.schedule_id)
    .bind(user.id)
    .execute(&pool)
    .await?;

    Ok(Json(GradeResult {
        step: next_step,
        due_on,
        interval_days: interval,
    }))
}
