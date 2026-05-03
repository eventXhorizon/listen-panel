use std::path::Path;
use std::str::FromStr;

use anyhow::Result;
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

const DB_PATH: &str = "data/app.db";

pub async fn pool() -> Result<SqlitePool> {
    if let Some(parent) = Path::new(DB_PATH).parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let url = format!("sqlite://{DB_PATH}");
    let options = SqliteConnectOptions::from_str(&url)?
        .create_if_missing(true)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}
