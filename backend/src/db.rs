use anyhow::Result;
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

pub async fn pool() -> Result<SqlitePool> {
    let db_path = crate::paths::db_path();
    if let Some(parent) = db_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    // Compile-time embedded migrations are rerun on startup when new files are added.
    sqlx::migrate!("./migrations").run(&pool).await?;

    reconcile_interrupted_jobs(&pool).await?;
    Ok(pool)
}

/// ASR/study jobs run on in-memory `tokio::spawn` tasks whose only durable state
/// is the `status` column. A crash or restart leaves those tasks dead while the
/// row stays `queued`/`running`, so the UI spins forever. Reset that orphaned
/// state on startup: ASR jobs are dead (mark failed so the user can re-run),
/// study generation is an idempotent upsert (reset to pending so it can resume).
async fn reconcile_interrupted_jobs(pool: &SqlitePool) -> Result<()> {
    let asr = sqlx::query(
        "UPDATE transcription_jobs \
         SET status = 'failed', \
             error = COALESCE(error, '服务重启,转写任务中断,请重新转写'), \
             progress = 100, \
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), \
             completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE status IN ('queued', 'running')",
    )
    .execute(pool)
    .await?;

    let study = sqlx::query(
        "UPDATE transcription_jobs \
         SET study_status = 'pending', study_error = NULL \
         WHERE study_status = 'running'",
    )
    .execute(pool)
    .await?;

    let (asr_n, study_n) = (asr.rows_affected(), study.rows_affected());
    if asr_n > 0 || study_n > 0 {
        tracing::info!(
            asr_jobs = asr_n,
            study_jobs = study_n,
            "reset interrupted jobs left running by a previous shutdown"
        );
    }
    Ok(())
}
