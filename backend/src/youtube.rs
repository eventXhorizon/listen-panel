//! YouTube metadata + caption fetching.
//!
//! Two public entry points:
//! - `fetch_videos_metadata`: hits YouTube Data API v3 (`videos.list`) — needs an API key.
//! - `fetch_captions`: shells out to `yt-dlp` to download English captions as JSON3, then
//!   parses cues into segments. Anonymous direct fetching from YouTube's timedtext endpoint
//!   is bot-blocked (returns 200/empty); `yt-dlp` handles client-rotation and signature
//!   decoding so caption coverage tracks whatever it supports today.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use tokio::process::Command;

use crate::models::NewsSegment;

const YTDLP_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct VideoMetadata {
    pub video_id: String,
    pub channel_id: String,
    pub channel_name: String,
    pub title: String,
    pub description: String,
    pub thumbnail_url: Option<String>,
    pub published_at: DateTime<Utc>,
    pub duration_sec: i64,
}

/// Batched `videos.list` (up to 50 IDs per request, splits automatically).
/// Costs 1 quota unit per request regardless of ID count.
pub async fn fetch_videos_metadata(
    client: &reqwest::Client,
    api_key: &str,
    video_ids: &[String],
) -> Result<Vec<VideoMetadata>> {
    if video_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::with_capacity(video_ids.len());
    for chunk in video_ids.chunks(50) {
        let joined = chunk.join(",");
        let url = format!(
            "https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id={joined}&key={api_key}"
        );
        let resp: VideosListResponse = client
            .get(&url)
            .send()
            .await
            .context("youtube videos.list batch request")?
            .error_for_status()
            .context("youtube videos.list batch status")?
            .json()
            .await
            .context("youtube videos.list batch parse")?;
        for item in resp.items {
            out.push(metadata_from_item(item)?);
        }
    }
    Ok(out)
}

fn metadata_from_item(item: VideoItem) -> Result<VideoMetadata> {
    let thumbnail = item
        .snippet
        .thumbnails
        .high
        .or(item.snippet.thumbnails.medium)
        .or(item.snippet.thumbnails.default)
        .map(|t| t.url);
    Ok(VideoMetadata {
        video_id: item.id,
        channel_id: item.snippet.channel_id,
        channel_name: item.snippet.channel_title,
        title: item.snippet.title,
        description: item.snippet.description,
        thumbnail_url: thumbnail,
        published_at: item.snippet.published_at,
        duration_sec: parse_iso8601_duration(&item.content_details.duration)?,
    })
}

/// `playlistItems.list` — returns video IDs from a playlist (e.g. a channel's uploads).
/// Costs 1 quota unit per call. `max_results` is capped at 50 by the API.
pub async fn fetch_playlist_video_ids(
    client: &reqwest::Client,
    api_key: &str,
    playlist_id: &str,
    max_results: usize,
) -> Result<Vec<String>> {
    #[derive(Deserialize)]
    struct Resp {
        #[serde(default)]
        items: Vec<Item>,
    }
    #[derive(Deserialize)]
    struct Item {
        #[serde(rename = "contentDetails")]
        content_details: Details,
    }
    #[derive(Deserialize)]
    struct Details {
        #[serde(rename = "videoId")]
        video_id: String,
    }

    let url = format!(
        "https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults={}&playlistId={playlist_id}&key={api_key}",
        max_results.clamp(1, 50)
    );
    let resp: Resp = client
        .get(&url)
        .send()
        .await
        .context("youtube playlistItems.list request")?
        .error_for_status()
        .context("youtube playlistItems.list status")?
        .json()
        .await
        .context("youtube playlistItems.list parse")?;
    Ok(resp
        .items
        .into_iter()
        .map(|i| i.content_details.video_id)
        .collect())
}

/// YouTube convention: a channel's auto-generated uploads playlist ID is the channel ID
/// with the leading "UC" replaced by "UU".
pub fn uploads_playlist_id(channel_id: &str) -> Result<String> {
    if !channel_id.starts_with("UC") || channel_id.len() < 4 {
        return Err(anyhow!("not a UC-prefixed channel id: {channel_id}"));
    }
    let mut s = String::with_capacity(channel_id.len());
    s.push_str("UU");
    s.push_str(&channel_id[2..]);
    Ok(s)
}

#[derive(Deserialize)]
struct VideosListResponse {
    #[serde(default)]
    items: Vec<VideoItem>,
}

#[derive(Deserialize)]
struct VideoItem {
    id: String,
    snippet: VideoSnippet,
    #[serde(rename = "contentDetails")]
    content_details: VideoContentDetails,
}

#[derive(Deserialize)]
struct VideoSnippet {
    title: String,
    #[serde(default)]
    description: String,
    #[serde(rename = "channelId")]
    channel_id: String,
    #[serde(rename = "channelTitle")]
    channel_title: String,
    #[serde(rename = "publishedAt")]
    published_at: DateTime<Utc>,
    #[serde(default)]
    thumbnails: Thumbnails,
}

#[derive(Deserialize)]
struct VideoContentDetails {
    duration: String,
}

#[derive(Deserialize, Default)]
struct Thumbnails {
    #[serde(default)]
    high: Option<Thumbnail>,
    #[serde(default)]
    medium: Option<Thumbnail>,
    #[serde(default)]
    default: Option<Thumbnail>,
}

#[derive(Deserialize)]
struct Thumbnail {
    url: String,
}

/// `PT1H5M30S` → `3930`. Returns error on malformed input.
fn parse_iso8601_duration(s: &str) -> Result<i64> {
    let rest = s
        .strip_prefix("PT")
        .ok_or_else(|| anyhow!("not an ISO 8601 PT duration: {s}"))?;
    let mut total = 0i64;
    let mut buf = String::new();
    for c in rest.chars() {
        if c.is_ascii_digit() {
            buf.push(c);
            continue;
        }
        let n: i64 = buf
            .parse()
            .with_context(|| format!("bad number before '{c}' in {s}"))?;
        buf.clear();
        match c {
            'H' => total += n * 3600,
            'M' => total += n * 60,
            'S' => total += n,
            other => return Err(anyhow!("unknown duration unit '{other}' in {s}")),
        }
    }
    if !buf.is_empty() {
        return Err(anyhow!("trailing digits without unit in {s}"));
    }
    Ok(total)
}

/// Fetches English captions via `yt-dlp` and parses the resulting JSON3 file.
/// Both `--write-subs` (manual) and `--write-auto-subs` (auto-generated) are enabled —
/// yt-dlp prefers manual when both exist and falls back to auto otherwise.
/// Returns `Ok(None)` when no English captions are available or yt-dlp fails for any reason.
pub async fn fetch_captions(
    _client: &reqwest::Client,
    video_id: &str,
    _accept_auto: bool,
) -> Result<Option<Vec<NewsSegment>>> {
    let unique = format!(
        "listen-panel-{}-{}",
        video_id,
        uuid::Uuid::new_v4().simple()
    );
    let out_prefix = std::env::temp_dir().join(&unique);
    let prefix_str = out_prefix.to_string_lossy().into_owned();
    let url = format!("https://www.youtube.com/watch?v={video_id}");

    let mut cmd = Command::new("yt-dlp");
    cmd.kill_on_drop(true)
        .arg("--quiet")
        .arg("--no-warnings")
        .arg("--no-playlist")
        .arg("--write-subs")
        .arg("--write-auto-subs")
        .arg("--skip-download")
        .arg("--sub-langs")
        .arg("en.*")
        .arg("--sub-format")
        .arg("json3")
        .arg("-o")
        .arg(&prefix_str)
        .arg(&url);

    match tokio::time::timeout(YTDLP_TIMEOUT, cmd.status()).await {
        Ok(Ok(s)) if !s.success() => {
            tracing::warn!(video_id, status = ?s, "yt-dlp non-zero exit");
        }
        Ok(Err(e)) => {
            tracing::warn!(video_id, "yt-dlp spawn failed: {e:#}");
            cleanup_prefix(&out_prefix).await;
            return Ok(None);
        }
        Err(_) => {
            tracing::warn!(video_id, "yt-dlp timed out after {:?}", YTDLP_TIMEOUT);
            cleanup_prefix(&out_prefix).await;
            return Ok(None);
        }
        Ok(Ok(_)) => {}
    }

    let json3_path = find_json3_for_prefix(&out_prefix);
    let Some(path) = json3_path else {
        return Ok(None);
    };
    let data_res = tokio::fs::read(&path).await;
    let _ = tokio::fs::remove_file(&path).await;
    let data = data_res.context("read yt-dlp json3 file")?;
    if data.is_empty() {
        return Ok(None);
    }
    let track: Json3Track = serde_json::from_slice(&data).context("parse yt-dlp json3")?;
    let segments = json3_to_segments(track);
    if segments.is_empty() {
        return Ok(None);
    }
    Ok(Some(segments))
}

fn find_json3_for_prefix(out_prefix: &std::path::Path) -> Option<PathBuf> {
    let dir = out_prefix.parent()?;
    let stem = out_prefix.file_name()?.to_string_lossy().into_owned();
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name();
        let s = name.to_string_lossy();
        if s.starts_with(&stem) && s.ends_with(".json3") {
            return Some(entry.path());
        }
    }
    None
}

async fn cleanup_prefix(out_prefix: &std::path::Path) {
    let Some(path) = find_json3_for_prefix(out_prefix) else {
        return;
    };
    let _ = tokio::fs::remove_file(&path).await;
}

#[derive(Deserialize)]
struct Json3Track {
    #[serde(default)]
    events: Vec<Json3Event>,
}

#[derive(Deserialize)]
struct Json3Event {
    #[serde(rename = "tStartMs", default)]
    t_start_ms: i64,
    #[serde(rename = "dDurationMs", default)]
    d_duration_ms: i64,
    #[serde(default)]
    segs: Vec<Json3Seg>,
}

#[derive(Deserialize)]
struct Json3Seg {
    #[serde(default)]
    utf8: String,
}

fn json3_to_segments(track: Json3Track) -> Vec<NewsSegment> {
    track
        .events
        .into_iter()
        .filter_map(|ev| {
            let text: String = ev.segs.iter().map(|s| s.utf8.as_str()).collect();
            let trimmed = text.trim_matches(|c: char| c.is_whitespace()).to_string();
            if trimmed.is_empty() {
                return None;
            }
            let dur = ev.d_duration_ms.max(0);
            Some(NewsSegment {
                start_ms: ev.t_start_ms,
                end_ms: ev.t_start_ms + dur,
                text: trimmed,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_uploads_playlist_id() {
        assert_eq!(
            uploads_playlist_id("UC16niRr50-MSBwiO3YDb3RA").unwrap(),
            "UU16niRr50-MSBwiO3YDb3RA"
        );
        assert!(uploads_playlist_id("PLxxx").is_err());
        assert!(uploads_playlist_id("UC").is_err());
    }

    #[test]
    fn parses_iso8601_durations() {
        assert_eq!(parse_iso8601_duration("PT30S").unwrap(), 30);
        assert_eq!(parse_iso8601_duration("PT5M").unwrap(), 300);
        assert_eq!(parse_iso8601_duration("PT1H5M30S").unwrap(), 3930);
        assert_eq!(parse_iso8601_duration("PT2H").unwrap(), 7200);
        assert_eq!(parse_iso8601_duration("PT0S").unwrap(), 0);
    }

    #[test]
    fn rejects_malformed_durations() {
        assert!(parse_iso8601_duration("5M30S").is_err());
        assert!(parse_iso8601_duration("PT5X").is_err());
        assert!(parse_iso8601_duration("PT5").is_err());
    }

    #[test]
    fn converts_json3_events_to_segments() {
        let track = Json3Track {
            events: vec![
                Json3Event {
                    t_start_ms: 0,
                    d_duration_ms: 1500,
                    segs: vec![
                        Json3Seg {
                            utf8: "Hello ".into(),
                        },
                        Json3Seg {
                            utf8: "world".into(),
                        },
                    ],
                },
                Json3Event {
                    t_start_ms: 2000,
                    d_duration_ms: 1000,
                    segs: vec![Json3Seg { utf8: "\n".into() }],
                },
                Json3Event {
                    t_start_ms: 3000,
                    d_duration_ms: 500,
                    segs: vec![Json3Seg { utf8: "Yes".into() }],
                },
            ],
        };
        let segs = json3_to_segments(track);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].text, "Hello world");
        assert_eq!(segs[0].start_ms, 0);
        assert_eq!(segs[0].end_ms, 1500);
        assert_eq!(segs[1].text, "Yes");
        assert_eq!(segs[1].start_ms, 3000);
    }
}
