//! YouTube metadata + caption fetching.
//!
//! Two public entry points:
//! - `fetch_video_metadata`: hits YouTube Data API v3 (`videos.list`) — needs an API key.
//! - `fetch_captions`: scrapes the watch page for `ytInitialPlayerResponse`, picks an English
//!   caption track (manual preferred over auto-generated), and parses JSON3 cues into segments.

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Utc};
use serde::Deserialize;

use crate::models::NewsSegment;

const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

pub async fn fetch_captions(
    client: &reqwest::Client,
    video_id: &str,
    accept_auto: bool,
) -> Result<Option<Vec<NewsSegment>>> {
    let watch_url = format!("https://www.youtube.com/watch?v={video_id}");
    let html = client
        .get(&watch_url)
        .header(reqwest::header::USER_AGENT, BROWSER_UA)
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .send()
        .await
        .context("fetch youtube watch page")?
        .error_for_status()
        .context("watch page status")?
        .text()
        .await
        .context("read watch page body")?;

    let player_response = match extract_player_response(&html) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("ytInitialPlayerResponse extraction failed for {video_id}: {e:#}");
            return Ok(None);
        }
    };
    let tracks = extract_caption_tracks(&player_response);
    let Some(track) = pick_english_track(&tracks, accept_auto) else {
        return Ok(None);
    };

    let url = format!("{}&fmt=json3", track.base_url);
    let json3: Json3Track = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, BROWSER_UA)
        .send()
        .await
        .context("fetch caption json3")?
        .error_for_status()
        .context("caption json3 status")?
        .json()
        .await
        .context("parse caption json3")?;

    let segments = json3_to_segments(json3);
    if segments.is_empty() {
        return Ok(None);
    }
    Ok(Some(segments))
}

#[derive(Debug)]
struct CaptionTrack {
    base_url: String,
    language_code: String,
    /// `Some("asr")` for auto-generated; absent for human-uploaded.
    kind: Option<String>,
}

fn extract_player_response(html: &str) -> Result<serde_json::Value> {
    const MARKER: &str = "ytInitialPlayerResponse";
    let idx = html
        .find(MARKER)
        .ok_or_else(|| anyhow!("ytInitialPlayerResponse marker not found"))?;
    let rest = &html[idx + MARKER.len()..];
    let eq_idx = rest
        .find('=')
        .ok_or_else(|| anyhow!("no '=' after ytInitialPlayerResponse"))?;
    let after_eq = &rest[eq_idx + 1..];
    let brace_idx = after_eq
        .find('{')
        .ok_or_else(|| anyhow!("no '{{' after '=' for ytInitialPlayerResponse"))?;
    let mut de = serde_json::Deserializer::from_str(&after_eq[brace_idx..]);
    let value = serde_json::Value::deserialize(&mut de)
        .context("parse ytInitialPlayerResponse JSON")?;
    Ok(value)
}

fn extract_caption_tracks(player: &serde_json::Value) -> Vec<CaptionTrack> {
    let Some(arr) = player
        .get("captions")
        .and_then(|c| c.get("playerCaptionsTracklistRenderer"))
        .and_then(|r| r.get("captionTracks"))
        .and_then(|a| a.as_array())
    else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| {
            Some(CaptionTrack {
                base_url: item.get("baseUrl")?.as_str()?.to_string(),
                language_code: item.get("languageCode")?.as_str()?.to_string(),
                kind: item
                    .get("kind")
                    .and_then(|k| k.as_str())
                    .map(|s| s.to_string()),
            })
        })
        .collect()
}

fn pick_english_track(tracks: &[CaptionTrack], accept_auto: bool) -> Option<&CaptionTrack> {
    if let Some(t) = tracks
        .iter()
        .find(|t| t.language_code.starts_with("en") && t.kind.is_none())
    {
        return Some(t);
    }
    if accept_auto {
        return tracks
            .iter()
            .find(|t| t.language_code.starts_with("en") && t.kind.as_deref() == Some("asr"));
    }
    None
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
    fn extracts_player_response_from_html() {
        let html = r#"<script>var x = 1; var ytInitialPlayerResponse = {"a":1,"b":{"c":2}};var y = 2;</script>"#;
        let v = extract_player_response(html).unwrap();
        assert_eq!(v["a"], 1);
        assert_eq!(v["b"]["c"], 2);
    }

    #[test]
    fn extract_player_response_errors_when_missing() {
        assert!(extract_player_response("<html>nothing here</html>").is_err());
    }

    #[test]
    fn extracts_caption_tracks_from_player_json() {
        let player = serde_json::json!({
            "captions": {
                "playerCaptionsTracklistRenderer": {
                    "captionTracks": [
                        {"baseUrl": "https://x/auto", "languageCode": "en", "kind": "asr"},
                        {"baseUrl": "https://x/manual", "languageCode": "en"},
                        {"baseUrl": "https://x/zh", "languageCode": "zh"}
                    ]
                }
            }
        });
        let tracks = extract_caption_tracks(&player);
        assert_eq!(tracks.len(), 3);
        assert_eq!(tracks[1].base_url, "https://x/manual");
    }

    #[test]
    fn picks_manual_over_asr() {
        let tracks = vec![
            CaptionTrack {
                base_url: "auto".into(),
                language_code: "en".into(),
                kind: Some("asr".into()),
            },
            CaptionTrack {
                base_url: "manual".into(),
                language_code: "en".into(),
                kind: None,
            },
        ];
        assert_eq!(
            pick_english_track(&tracks, true).map(|t| t.base_url.as_str()),
            Some("manual")
        );
        assert_eq!(
            pick_english_track(&tracks, false).map(|t| t.base_url.as_str()),
            Some("manual")
        );
    }

    #[test]
    fn falls_back_to_asr_when_allowed() {
        let tracks = vec![CaptionTrack {
            base_url: "auto".into(),
            language_code: "en-GB".into(),
            kind: Some("asr".into()),
        }];
        assert!(pick_english_track(&tracks, true).is_some());
        assert!(pick_english_track(&tracks, false).is_none());
    }

    #[test]
    fn rejects_non_english_tracks() {
        let tracks = vec![CaptionTrack {
            base_url: "zh".into(),
            language_code: "zh-CN".into(),
            kind: None,
        }];
        assert!(pick_english_track(&tracks, true).is_none());
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
