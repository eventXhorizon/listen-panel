use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use chrono::Utc;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;

use crate::auth::CurrentUser;
use crate::error::Result;
use crate::models::{CreateMaterial, Material, UpdateMaterial};

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/materials/metadata", post(metadata))
        .route("/materials", get(list).post(create))
        .route(
            "/materials/:id",
            get(get_one).put(update).delete(delete_one),
        )
}

const SELECT_COLS: &str =
    "id, user_id, title, source_type, source_ref, text, notes, created_at, updated_at";

#[derive(Debug, Deserialize)]
struct MaterialMetadataReq {
    source_ref: String,
}

#[derive(Debug, Serialize)]
struct MaterialMetadataResp {
    source_type: Option<&'static str>,
    source_ref: String,
    title: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExternalSourceType {
    YouTube,
    Bilibili,
}

impl ExternalSourceType {
    fn as_str(self) -> &'static str {
        match self {
            Self::YouTube => "youtube",
            Self::Bilibili => "bilibili",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DetectedExternalSource {
    kind: ExternalSourceType,
    source_ref: String,
}

async fn metadata(
    State(http): State<reqwest::Client>,
    _user: CurrentUser,
    Json(input): Json<MaterialMetadataReq>,
) -> Result<Json<MaterialMetadataResp>> {
    let raw = input.source_ref.trim();
    let Some(detected) = detect_external_source(raw) else {
        return Ok(Json(MaterialMetadataResp {
            source_type: None,
            source_ref: raw.to_string(),
            title: None,
        }));
    };

    let title = fetch_source_title(&http, &detected).await;
    Ok(Json(MaterialMetadataResp {
        source_type: Some(detected.kind.as_str()),
        source_ref: detected.source_ref,
        title,
    }))
}

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
    let text_changed = input
        .text
        .as_ref()
        .is_some_and(|next_text| next_text != &old.text);

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

    if text_changed {
        let deleted = sqlx::query(
            "DELETE FROM transcription_jobs \
             WHERE material_id = ? AND user_id = ?",
        )
        .bind(id)
        .bind(user.id)
        .execute(&pool)
        .await?;
        if deleted.rows_affected() > 0 {
            tracing::info!(
                material_id = id,
                user_id = user.id,
                jobs = deleted.rows_affected(),
                "cleared stale transcription jobs after material text edit"
            );
        }
    }

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

fn detect_external_source(input: &str) -> Option<DetectedExternalSource> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(id) = youtube_id(trimmed) {
        return Some(DetectedExternalSource {
            kind: ExternalSourceType::YouTube,
            source_ref: id,
        });
    }

    if let Some(bvid) = bilibili_bvid(trimmed) {
        return Some(DetectedExternalSource {
            kind: ExternalSourceType::Bilibili,
            source_ref: bvid,
        });
    }

    None
}

fn youtube_id(input: &str) -> Option<String> {
    if is_youtube_id(input) {
        return Some(input.to_string());
    }

    let url = Url::parse(input).ok()?;
    let host = normalized_host(&url)?;
    if host == "youtu.be" {
        let id = url.path().trim_start_matches('/').split('/').next()?;
        return is_youtube_id(id).then(|| id.to_string());
    }
    if !(is_host_or_subdomain(&host, "youtube.com")
        || is_host_or_subdomain(&host, "youtube-nocookie.com"))
    {
        return None;
    }

    if let Some(v) = url.query_pairs().find_map(|(key, value)| {
        if key == "v" && is_youtube_id(&value) {
            Some(value.into_owned())
        } else {
            None
        }
    }) {
        return Some(v);
    }

    let mut segments = url.path_segments()?;
    while let Some(segment) = segments.next() {
        if matches!(segment, "embed" | "shorts" | "live") {
            let id = segments.next()?;
            return is_youtube_id(id).then(|| id.to_string());
        }
    }
    None
}

fn is_youtube_id(value: &str) -> bool {
    value.len() == 11
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn bilibili_bvid(input: &str) -> Option<String> {
    if let Ok(url) = Url::parse(input) {
        let host = normalized_host(&url)?;
        if is_host_or_subdomain(&host, "bilibili.com") {
            return find_bvid(url.path()).map(str::to_string);
        }
        return None;
    }

    find_bvid(input).map(str::to_string)
}

fn find_bvid(input: &str) -> Option<&str> {
    for (idx, _) in input.match_indices("BV") {
        let candidate: String = input[idx..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        if candidate.len() >= 10 {
            return input.get(idx..idx + candidate.len());
        }
    }
    None
}

fn normalized_host(url: &Url) -> Option<String> {
    Some(
        url.host_str()?
            .trim_start_matches("www.")
            .to_ascii_lowercase(),
    )
}

fn is_host_or_subdomain(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

async fn fetch_source_title(
    http: &reqwest::Client,
    detected: &DetectedExternalSource,
) -> Option<String> {
    let result = match detected.kind {
        ExternalSourceType::YouTube => fetch_youtube_title(http, &detected.source_ref).await,
        ExternalSourceType::Bilibili => fetch_bilibili_title(http, &detected.source_ref).await,
    };
    match result {
        Ok(title) => title.and_then(clean_title),
        Err(err) => {
            tracing::warn!(
                source_type = detected.kind.as_str(),
                "failed to fetch material metadata title: {err:#}"
            );
            None
        }
    }
}

async fn fetch_youtube_title(
    http: &reqwest::Client,
    video_id: &str,
) -> anyhow::Result<Option<String>> {
    let watch_url = format!("https://www.youtube.com/watch?v={video_id}");
    let url = Url::parse_with_params(
        "https://www.youtube.com/oembed",
        &[("url", watch_url.as_str()), ("format", "json")],
    )?;
    let resp = http.get(url).send().await?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let body: Value = resp.json().await?;
    Ok(body
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_string))
}

async fn fetch_bilibili_title(
    http: &reqwest::Client,
    bvid: &str,
) -> anyhow::Result<Option<String>> {
    if let Some(title) = fetch_bilibili_api_title(http, bvid).await? {
        return Ok(Some(title));
    }
    fetch_bilibili_html_title(http, bvid).await
}

async fn fetch_bilibili_api_title(
    http: &reqwest::Client,
    bvid: &str,
) -> anyhow::Result<Option<String>> {
    let referer = format!("https://www.bilibili.com/video/{bvid}/");
    let url = Url::parse_with_params(
        "https://api.bilibili.com/x/web-interface/view",
        &[("bvid", bvid)],
    )?;
    let resp = http
        .get(url)
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 listen-panel metadata fetcher",
        )
        .header(reqwest::header::REFERER, referer)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let body: Value = resp.json().await?;
    if body.get("code").and_then(Value::as_i64) != Some(0) {
        return Ok(None);
    }
    Ok(extract_bilibili_api_title(&body))
}

async fn fetch_bilibili_html_title(
    http: &reqwest::Client,
    bvid: &str,
) -> anyhow::Result<Option<String>> {
    let url = format!("https://www.bilibili.com/video/{bvid}");
    let resp = http
        .get(url)
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 listen-panel metadata fetcher",
        )
        .send()
        .await?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let html = resp.text().await?;
    Ok(extract_html_title(&html))
}

fn extract_html_title(html: &str) -> Option<String> {
    find_meta_content(html, "og:title")
        .or_else(|| find_tag_text(html, "title"))
        .map(|title| {
            title
                .replace("_哔哩哔哩_bilibili", "")
                .replace("-哔哩哔哩", "")
        })
        .and_then(clean_title)
}

fn extract_bilibili_api_title(body: &Value) -> Option<String> {
    if body.get("code").and_then(Value::as_i64) != Some(0) {
        return None;
    }
    body.get("data")
        .and_then(|data| data.get("title"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn find_meta_content(html: &str, property: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut offset = 0;
    while let Some(start) = lower[offset..].find("<meta") {
        let start = offset + start;
        let end = lower[start..].find('>').map(|pos| start + pos)?;
        let tag = &html[start..=end];
        let tag_lower = &lower[start..=end];
        if !(tag_lower.contains(&format!("property=\"{property}\""))
            || tag_lower.contains(&format!("property='{property}'"))
            || tag_lower.contains(&format!("name=\"{property}\""))
            || tag_lower.contains(&format!("name='{property}'")))
        {
            offset = end + 1;
            continue;
        }
        if let Some(content) = attr_value(tag, "content") {
            return Some(content);
        }
        offset = end + 1;
    }
    None
}

fn find_tag_text(html: &str, tag: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{tag}");
    let start = lower.find(&open)?;
    let content_start = lower[start..].find('>').map(|pos| start + pos + 1)?;
    let close = format!("</{tag}>");
    let content_end = lower[content_start..]
        .find(&close)
        .map(|pos| content_start + pos)?;
    Some(html[content_start..content_end].to_string())
}

fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{attr}=");
    let start = lower.find(&needle)? + needle.len();
    let bytes = tag.as_bytes();
    let quote = *bytes.get(start)?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    let value_start = start + 1;
    let value_end = tag[value_start..].find(quote as char)? + value_start;
    Some(html_decode(&tag[value_start..value_end]))
}

fn clean_title(value: String) -> Option<String> {
    let title = html_decode(&value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() { None } else { Some(title) }
}

fn html_decode(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_youtube_links_and_ids() {
        assert_eq!(
            detect_external_source("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
            Some(DetectedExternalSource {
                kind: ExternalSourceType::YouTube,
                source_ref: "dQw4w9WgXcQ".to_string(),
            })
        );
        assert_eq!(
            detect_external_source("https://youtu.be/dQw4w9WgXcQ?t=1"),
            Some(DetectedExternalSource {
                kind: ExternalSourceType::YouTube,
                source_ref: "dQw4w9WgXcQ".to_string(),
            })
        );
        assert_eq!(
            detect_external_source("dQw4w9WgXcQ")
                .expect("expected bare youtube id")
                .kind,
            ExternalSourceType::YouTube
        );
    }

    #[test]
    fn detects_bilibili_links_and_bvids() {
        assert_eq!(
            detect_external_source("https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=1"),
            Some(DetectedExternalSource {
                kind: ExternalSourceType::Bilibili,
                source_ref: "BV1xx411c7mD".to_string(),
            })
        );
        assert_eq!(
            detect_external_source("BV1xx411c7mD")
                .expect("expected bare bvid")
                .kind,
            ExternalSourceType::Bilibili
        );
    }

    #[test]
    fn extracts_titles_from_html() {
        assert_eq!(
            extract_html_title(
                r#"<html><head><meta property="og:title" content="Hello &amp; Rust_哔哩哔哩_bilibili"></head></html>"#
            ),
            Some("Hello & Rust".to_string())
        );
        assert_eq!(
            extract_html_title("<title>Fallback &quot;Title&quot;</title>"),
            Some("Fallback \"Title\"".to_string())
        );
    }

    #[test]
    fn extracts_bilibili_api_title() {
        let body = serde_json::json!({
            "code": 0,
            "data": {
                "bvid": "BV1CRogByENi",
                "title": "A Bilibili Video Title"
            }
        });
        assert_eq!(
            extract_bilibili_api_title(&body),
            Some("A Bilibili Video Title".to_string())
        );

        let failed = serde_json::json!({
            "code": -404,
            "message": "not found"
        });
        assert_eq!(extract_bilibili_api_title(&failed), None);
    }
}
