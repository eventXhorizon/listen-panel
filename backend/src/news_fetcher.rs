//! Periodic ingestion of YouTube news videos from a fixed set of channels.
//!
//! Flow (per channel, every `RUN_INTERVAL`):
//!   uploads playlist -> latest N video IDs -> skip ones already in `news_items` ->
//!   batched videos.list for metadata -> fetch captions per video ->
//!   DeepSeek call to label topic/difficulty and extract idioms -> INSERT.

use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::json;
use sqlx::SqlitePool;

use crate::config::SharedLlm;
use crate::models::{NewsIdiom, NewsSegment};
use crate::youtube::{self, VideoMetadata};

const RUN_INTERVAL: Duration = Duration::from_secs(3 * 3600);
const STARTUP_DELAY: Duration = Duration::from_secs(45);
const PER_CHANNEL_LIMIT: usize = 20;
const IDIOMS_PER_VIDEO: usize = 8;
/// Cap transcript length sent to DeepSeek to keep prompts bounded.
const TRANSCRIPT_CHAR_CAP: usize = 15_000;
/// Skip videos outside this duration window (in seconds). Keeps the feed focused on
/// shadowing-friendly lengths and rejects breaking-news clips and shorts. The upper
/// bound is generous (60 min) so high-quality long-form content can still get in;
/// the quality filter does the real curation.
const MIN_DURATION_SEC: i64 = 180; // 3 minutes
const MAX_DURATION_SEC: i64 = 3600; // 60 minutes

#[derive(Debug, Clone, Copy)]
pub struct ChannelDef {
    pub source: &'static str,
    pub channel_id: &'static str,
    pub channel_name: &'static str,
    /// Material language: "en" or "ja". Drives DeepSeek prompt selection and
    /// the `language` filter on `/api/news`.
    pub language: &'static str,
}

/// Hardcoded for the first version. To change feeds, edit this and restart.
/// Channel IDs resolved from each outlet's @handle on YouTube.
pub const CHANNELS: &[ChannelDef] = &[
    // English finance/business
    ChannelDef {
        source: "cnbc",
        channel_id: "UCo7a6riBFJ3tkeHjvkXPn1g",
        channel_name: "CNBC International",
        language: "en",
    },
    ChannelDef {
        source: "bloomberg",
        channel_id: "UCUMZ7gohGI9HcU9VNsr2FJQ",
        channel_name: "Bloomberg",
        language: "en",
    },
    ChannelDef {
        source: "wsj",
        channel_id: "UCK7tptUDHh-RYDsdxO1-5QQ",
        channel_name: "The Wall Street Journal",
        language: "en",
    },
    ChannelDef {
        source: "ft",
        channel_id: "UCoUxsWakJucWg46KW5RsvPw",
        channel_name: "Financial Times",
        language: "en",
    },
    // Japanese finance/business
    ChannelDef {
        source: "wbs",
        channel_id: "UCkKVQ_GNjd8FbAuT6xDcWgg",
        channel_name: "テレ東BIZ",
        language: "ja",
    },
    ChannelDef {
        source: "nikkei",
        channel_id: "UCHL12woHGeiqAqLrK-pJe7g",
        channel_name: "日本経済新聞",
        language: "ja",
    },
    ChannelDef {
        source: "pivot",
        channel_id: "UCMPIUePGM1IGokGZCxvVxUg",
        channel_name: "PIVOT 公式チャンネル",
        language: "ja",
    },
    ChannelDef {
        source: "newspicks",
        channel_id: "UCfTnJmRQP79C4y_BMF_XrlA",
        channel_name: "NewsPicks",
        language: "ja",
    },
];

/// Spawn the recurring fetch task. No-ops (with a warning) if the API key is empty.
pub fn spawn(pool: SqlitePool, http: reqwest::Client, llm: SharedLlm, api_key: String) {
    if api_key.is_empty() {
        tracing::warn!("YOUTUBE_API_KEY not set — news fetcher disabled");
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            if let Err(e) = run_once(&pool, &http, &llm, &api_key).await {
                tracing::error!("news fetcher run failed: {e:#}");
            }
            tokio::time::sleep(RUN_INTERVAL).await;
        }
    });
}

pub async fn run_once(
    pool: &SqlitePool,
    http: &reqwest::Client,
    llm: &SharedLlm,
    api_key: &str,
) -> Result<usize> {
    tracing::info!("news fetcher: starting run");
    let mut total = 0usize;
    for ch in CHANNELS {
        match fetch_channel(pool, http, llm, api_key, *ch).await {
            Ok(n) => {
                total += n;
                tracing::info!(channel = ch.channel_name, added = n, "channel done");
            }
            Err(e) => {
                tracing::warn!(
                    channel = ch.channel_name,
                    "channel failed: {}",
                    redact_api_key(&format!("{e:#}"))
                );
            }
        }
    }
    tracing::info!(total_added = total, "news fetcher: run complete");
    Ok(total)
}

async fn fetch_channel(
    pool: &SqlitePool,
    http: &reqwest::Client,
    llm: &SharedLlm,
    api_key: &str,
    ch: ChannelDef,
) -> Result<usize> {
    let uploads_id = youtube::uploads_playlist_id(ch.channel_id)?;
    let ids = youtube::fetch_playlist_video_ids(http, api_key, &uploads_id, PER_CHANNEL_LIMIT)
        .await
        .with_context(|| format!("list uploads for {}", ch.channel_name))?;

    let mut new_ids = Vec::with_capacity(ids.len());
    for id in ids {
        let exists: Option<i64> =
            sqlx::query_scalar("SELECT id FROM news_items WHERE yt_video_id = ?")
                .bind(&id)
                .fetch_optional(pool)
                .await?;
        if exists.is_none() {
            new_ids.push(id);
        }
    }
    if new_ids.is_empty() {
        return Ok(0);
    }

    let metas = youtube::fetch_videos_metadata(http, api_key, &new_ids)
        .await
        .with_context(|| format!("batch metadata for {}", ch.channel_name))?;

    let mut added = 0usize;
    let mut skipped_duration = 0usize;
    for meta in metas {
        if meta.duration_sec < MIN_DURATION_SEC || meta.duration_sec > MAX_DURATION_SEC {
            skipped_duration += 1;
            continue;
        }
        let video_id = meta.video_id.clone();
        if let Err(e) = ingest_one(pool, http, llm, ch, meta).await {
            tracing::warn!(video_id, "ingest failed: {e:#}");
            continue;
        }
        added += 1;
    }
    if skipped_duration > 0 {
        tracing::info!(
            channel = ch.channel_name,
            skipped = skipped_duration,
            "skipped videos outside duration window"
        );
    }
    Ok(added)
}

async fn ingest_one(
    pool: &SqlitePool,
    http: &reqwest::Client,
    llm: &SharedLlm,
    ch: ChannelDef,
    meta: VideoMetadata,
) -> Result<()> {
    // Only fetch manually-uploaded captions; auto-generated would be the ASR fallback (deferred).
    let captions = match youtube::fetch_captions(http, &meta.video_id, ch.language).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(video_id = meta.video_id, "caption fetch failed: {e:#}");
            None
        }
    };

    let (segments, has_caps) = match captions {
        Some(s) => (s, true),
        None => (Vec::new(), false),
    };

    let mut topic = "other".to_string();
    let mut difficulty: i64 = 3;
    let mut quality: Option<i64> = None;
    let mut quality_reason: Option<String> = None;
    let mut idioms: Vec<NewsIdiom> = Vec::new();
    let mut analyzed_at: Option<DateTime<Utc>> = None;

    if has_caps {
        let transcript = transcript_for_prompt(&segments);
        match analyze(http, llm, ch.language, &meta.title, &transcript).await {
            Ok(a) => {
                topic = a.topic;
                difficulty = a.difficulty;
                quality = Some(a.quality);
                quality_reason = if a.quality_reason.is_empty() {
                    None
                } else {
                    Some(a.quality_reason)
                };
                idioms = a.idioms;
                analyzed_at = Some(Utc::now());
            }
            Err(e) => {
                tracing::warn!(video_id = meta.video_id, "DeepSeek analysis failed: {e:#}");
            }
        }
    }

    let segments_json = serde_json::to_string(&segments)?;
    let idioms_json = serde_json::to_string(&idioms)?;
    let has_captions_int: i64 = if has_caps { 1 } else { 0 };

    sqlx::query(
        "INSERT INTO news_items \
           (yt_video_id, source, channel_id, channel_name, title, description, thumbnail_url, \
            published_at, duration_sec, language, topic, difficulty, has_captions, \
            quality, quality_reason, view_count, \
            segments_json, idioms_json, analyzed_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(yt_video_id) DO NOTHING",
    )
    .bind(&meta.video_id)
    .bind(ch.source)
    .bind(&meta.channel_id)
    .bind(&meta.channel_name)
    .bind(&meta.title)
    .bind(&meta.description)
    .bind(meta.thumbnail_url.as_deref())
    .bind(meta.published_at)
    .bind(meta.duration_sec)
    .bind(ch.language)
    .bind(&topic)
    .bind(difficulty)
    .bind(has_captions_int)
    .bind(quality)
    .bind(quality_reason.as_deref())
    .bind(meta.view_count)
    .bind(&segments_json)
    .bind(&idioms_json)
    .bind(analyzed_at)
    .execute(pool)
    .await?;

    Ok(())
}

pub fn transcript_for_prompt(segments: &[NewsSegment]) -> String {
    let mut out = String::new();
    for seg in segments {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&seg.text);
        if out.len() >= TRANSCRIPT_CHAR_CAP {
            break;
        }
    }
    if out.len() > TRANSCRIPT_CHAR_CAP {
        // Cut to a UTF-8 char boundary at or before the byte cap so we don't
        // split multi-byte Japanese characters and panic on truncate().
        let mut cut = TRANSCRIPT_CHAR_CAP;
        while cut > 0 && !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
    }
    out
}

#[derive(Debug)]
pub struct Analysis {
    pub topic: String,
    pub difficulty: i64,
    pub quality: i64,
    pub quality_reason: String,
    pub idioms: Vec<NewsIdiom>,
}

pub async fn analyze(
    http: &reqwest::Client,
    llm: &SharedLlm,
    language: &str,
    title: &str,
    transcript: &str,
) -> Result<Analysis> {
    let cfg = llm.read().await.clone();
    if !cfg.configured() {
        return Err(anyhow!("DeepSeek API key not configured"));
    }
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let system = if language == "ja" {
        japanese_system_prompt()
    } else {
        english_system_prompt()
    };
    let body = json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user",   "content": user_prompt(title, transcript) },
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.3,
    });

    let res = http
        .post(&url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
        .context("DeepSeek request")?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        let trimmed: String = text.chars().take(300).collect();
        return Err(anyhow!("DeepSeek {status}: {trimmed}"));
    }

    let raw: serde_json::Value = res.json().await.context("DeepSeek json envelope")?;
    let content = raw
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|s| s.as_str())
        .ok_or_else(|| anyhow!("DeepSeek response missing message.content"))?;

    parse_analysis(content)
}

fn parse_analysis(content: &str) -> Result<Analysis> {
    #[derive(Deserialize)]
    struct Raw {
        #[serde(default)]
        topic: String,
        #[serde(default)]
        difficulty: serde_json::Value,
        #[serde(default)]
        quality: serde_json::Value,
        #[serde(default)]
        quality_reason: String,
        #[serde(default)]
        idioms: Vec<RawIdiom>,
    }
    #[derive(Deserialize)]
    struct RawIdiom {
        #[serde(default)]
        phrase: String,
        #[serde(default)]
        anchor_sentence: String,
        #[serde(default)]
        meaning_zh: String,
        #[serde(default)]
        usage_note: Option<String>,
    }

    let raw: Raw =
        serde_json::from_str(content).with_context(|| format!("parse analysis JSON: {content}"))?;

    let topic = match raw.topic.as_str() {
        "finance" | "politics" | "tech" | "culture" => raw.topic,
        _ => "other".to_string(),
    };
    let difficulty = raw
        .difficulty
        .as_i64()
        .or_else(|| raw.difficulty.as_f64().map(|f| f.round() as i64))
        .or_else(|| raw.difficulty.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(3)
        .clamp(1, 5);
    let quality = raw
        .quality
        .as_i64()
        .or_else(|| raw.quality.as_f64().map(|f| f.round() as i64))
        .or_else(|| raw.quality.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(5)
        .clamp(1, 10);
    let quality_reason = raw.quality_reason.trim().to_string();

    let idioms = raw
        .idioms
        .into_iter()
        .filter(|i| !i.phrase.trim().is_empty() && !i.meaning_zh.trim().is_empty())
        .map(|i| NewsIdiom {
            phrase: i.phrase.trim().to_string(),
            anchor_sentence: i.anchor_sentence.trim().to_string(),
            meaning_zh: i.meaning_zh.trim().to_string(),
            usage_note: i
                .usage_note
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
        })
        .take(IDIOMS_PER_VIDEO)
        .collect();

    Ok(Analysis {
        topic,
        difficulty,
        quality,
        quality_reason,
        idioms,
    })
}

fn english_system_prompt() -> &'static str {
    "你是一个为中国英语学习者提取地道英语表达 + 评估学习价值的助手。你会收到一段英语新闻视频的标题和字幕原文,需要:\n\
     1. 判断话题(必须是 finance / politics / tech / culture / other 之一)\n\
     2. 评估学习难度(整数 1-5,综合词汇、语速感和句法复杂度)\n\
     3. 评估「学习价值」 quality(整数 1-10),标准是「对真心想用日常英语的中级学习者,这段内容值不值得花 10 分钟跟读」 — 综合语言地道度、信息密度、可迁移到日常对话的程度:\n\
        - 9-10:NYT Daily / 60 Minutes 级别 — 长留人话术、专业领域语言、思路完整、句式多样\n\
        - 7-8:WSJ / Bloomberg explainer 级别 — 清晰、有信息、可学习点充足\n\
        - 5-6:能看但松散,信息密度低、重复、内容空泛\n\
        - 1-4:vlog 风、宣传、断章碎念、闲聊\n\
     4. 给出 quality_reason(一句中文,说明为什么给这个分)\n\
     5. 从原文中挑选 8 个最具学习价值的「地道表达」:\n\
        - 优先选短语动词(phrasal verbs)、固定搭配(collocations)、习语(idioms)、行业说法、隐喻用法\n\
        - 避免单个常见单词,避免字面直白的短语\n\
        - phrase 必须是原文中出现过的多词组合\n\
        - anchor_sentence 必须是原文中含该表达的完整自然句(可截取,但要语义完整)\n\
        - meaning_zh 用中文简洁解释含义\n\
        - usage_note 可选,提示什么场景常用 / 注意点 / 易混淆\n\
     输出必须是严格的 JSON,不要 markdown 包裹、不要任何额外解释。\n\
     JSON 结构:\n\
     {\"topic\":\"...\",\"difficulty\":1-5,\"quality\":1-10,\"quality_reason\":\"...\",\"idioms\":[{\"phrase\":\"...\",\"anchor_sentence\":\"...\",\"meaning_zh\":\"...\",\"usage_note\":\"...\"} × 8]}"
}

fn japanese_system_prompt() -> &'static str {
    "あなたは中国語话者の日本語学习者向けに、地道な日本語表現の抽出 + 学习価値の評価を行うアシスタントです。日本語ニュース動画のタイトルと字幕原文を受け取り、以下を行ってください:\n\
     1. トピックを判定(必ず finance / politics / tech / culture / other のいずれか)\n\
     2. 学习難易度を整数 1-5 で評価(语汇、话速感、文型の複雑さを総合)\n\
     3.「学习価値」 quality を整数 1-10 で評価。「日常会話で使える日本語を真剣に身につけたい中級学习者にとって、この 10 分間をシャドーイングする価値があるか」— 自然な言い回しの密度、情報量、日常会話への転用しやすさを総合:\n\
        - 9-10:NHK 解説 / 日経モーニングプラス級 — 専門語彙が豊富、思考が完結、文型のバリエーション豊か\n\
        - 7-8:テレ東BIZ / NewsPicks explainer 級 — 明瞭、情報あり、学习ポイント十分\n\
        - 5-6:見られるが散漫、情報密度低、繰り返し、内容が薄い\n\
        - 1-4:vlog 風、宣伝、断片的なつぶやき、雑談\n\
     4. quality_reason を一文の中文で記述(なぜその点数なのか)\n\
     5. 原文から日本語学习者にとって最も価値のある「自然な表現」を 8 つ選びます:\n\
        - 範疇は自由に判断してよい — 慣用句、四字熟語、二字熟語、N1/N2 レベルの副助詞・接続表現、ビジネス用語、敬語表現、和制英語、口語的な省略形、隠喩、コロケーションなど何でもよい\n\
        - 一見すると平凡だが、日本語学习者がぶつかる用法を優先(教科書に出ない自然さ)\n\
        - 単独で覚えても汎用性のある表現を选ぶ\n\
        - phrase は原文に実際に出現したフレーズ(2 文字以上、複合語や定型句を含む)\n\
        - anchor_sentence は原文中の該当表現を含む自然な完全文(短く切ってもよいが、意味が独立して通る範囲で)\n\
        - meaning_zh は中文で簡潔に意味を説明\n\
        - usage_note は任意 — 用いる文脈、注意点、よくある誤用、類义表现など\n\
     出力は厳格な JSON のみ、Markdown ラップや追加の説明文を含めないこと。\n\
     JSON 構造:\n\
     {\"topic\":\"...\",\"difficulty\":1-5,\"quality\":1-10,\"quality_reason\":\"...\",\"idioms\":[{\"phrase\":\"...\",\"anchor_sentence\":\"...\",\"meaning_zh\":\"...\",\"usage_note\":\"...\"} × 8]}"
}

fn user_prompt(title: &str, transcript: &str) -> String {
    format!("Title: {title}\n\nTranscript:\n{transcript}")
}

/// Replace `key=<value>` with `key=REDACTED` so YouTube Data API keys don't leak
/// into error logs (reqwest's `error_for_status` formatter includes the request URL).
fn redact_api_key(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find("key=") {
        out.push_str(&rest[..idx + 4]);
        rest = &rest[idx + 4..];
        let end = rest
            .find(|c: char| {
                !(c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~')
            })
            .unwrap_or(rest.len());
        out.push_str("REDACTED");
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_well_formed_analysis() {
        let content = r#"{
            "topic": "finance",
            "difficulty": 4,
            "idioms": [
                {"phrase":"call off","anchor_sentence":"They called off the deal at the last minute.","meaning_zh":"取消"},
                {"phrase":"in the red","anchor_sentence":"The firm has been in the red for three quarters.","meaning_zh":"亏损","usage_note":"财经常用"}
            ]
        }"#;
        let a = parse_analysis(content).unwrap();
        assert_eq!(a.topic, "finance");
        assert_eq!(a.difficulty, 4);
        assert_eq!(a.idioms.len(), 2);
        assert_eq!(a.idioms[0].phrase, "call off");
        assert!(a.idioms[0].usage_note.is_none());
        assert_eq!(a.idioms[1].usage_note.as_deref(), Some("财经常用"));
    }

    #[test]
    fn defaults_unknown_topic_to_other() {
        let content = r#"{"topic":"sports","difficulty":2,"idioms":[]}"#;
        let a = parse_analysis(content).unwrap();
        assert_eq!(a.topic, "other");
    }

    #[test]
    fn clamps_difficulty_out_of_range() {
        let high = parse_analysis(r#"{"topic":"tech","difficulty":9,"idioms":[]}"#).unwrap();
        let low = parse_analysis(r#"{"topic":"tech","difficulty":-1,"idioms":[]}"#).unwrap();
        let str_diff = parse_analysis(r#"{"topic":"tech","difficulty":"4","idioms":[]}"#).unwrap();
        let missing = parse_analysis(r#"{"topic":"tech","idioms":[]}"#).unwrap();
        assert_eq!(high.difficulty, 5);
        assert_eq!(low.difficulty, 1);
        assert_eq!(str_diff.difficulty, 4);
        assert_eq!(missing.difficulty, 3);
    }

    #[test]
    fn drops_empty_idioms_and_caps_at_eight() {
        let mut items = Vec::new();
        for i in 0..12 {
            items.push(format!(
                r#"{{"phrase":"p{i}","anchor_sentence":"s{i}","meaning_zh":"m{i}"}}"#
            ));
        }
        items.push(r#"{"phrase":"","anchor_sentence":"x","meaning_zh":"y"}"#.into());
        let content = format!(
            r#"{{"topic":"culture","difficulty":3,"idioms":[{}]}}"#,
            items.join(",")
        );
        let a = parse_analysis(&content).unwrap();
        assert_eq!(a.idioms.len(), 8);
        assert_eq!(a.idioms[0].phrase, "p0");
    }

    #[test]
    fn redacts_api_keys_in_strings() {
        let input = "GET https://x?part=foo&key=AIzaSyABCDEF&maxResults=10";
        assert_eq!(
            redact_api_key(input),
            "GET https://x?part=foo&key=REDACTED&maxResults=10"
        );
        // multiple occurrences
        let multi = "k1: key=abc, k2: (key=def)";
        assert_eq!(redact_api_key(multi), "k1: key=REDACTED, k2: (key=REDACTED)");
        // no key, untouched
        assert_eq!(redact_api_key("hello"), "hello");
    }

    #[test]
    fn transcript_cap_enforced() {
        let long_seg = NewsSegment {
            start_ms: 0,
            end_ms: 1000,
            text: "x".repeat(20_000),
        };
        let out = transcript_for_prompt(&[long_seg]);
        assert!(out.len() <= TRANSCRIPT_CHAR_CAP);
    }

    #[test]
    fn transcript_cap_handles_multibyte_chars() {
        // Japanese 3-byte char that would land mid-codepoint at TRANSCRIPT_CHAR_CAP=15000.
        let long_seg = NewsSegment {
            start_ms: 0,
            end_ms: 1000,
            text: "あ".repeat(8000), // 24,000 bytes, char count 8000
        };
        let out = transcript_for_prompt(&[long_seg]);
        assert!(out.len() <= TRANSCRIPT_CHAR_CAP);
        // Must end at a char boundary — must be parseable as valid UTF-8.
        assert_eq!(out, out.as_str().to_string());
    }
}
