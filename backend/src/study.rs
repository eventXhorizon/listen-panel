use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::config::SharedLlm;
use crate::models::TranscriptSegment;

const SYSTEM_PROMPT: &str = "你是英语听力学习助手。你会把 ASR 转写分段整理成适合中文学习者阅读的学习讲解。\n\
对每个分段返回:自然中文翻译、值得说明的常用语法点、固定用法/固定搭配。\n\
语法点优先覆盖真实出现且有学习价值的结构,例如虚拟语气、现在完成时、过去完成时、被动语态、定语从句、状语从句、非谓语、情态动词、强调/倒装等;不要硬凑。\n\
固定用法/搭配包含 phrasal verbs、介词搭配、常见句型、习惯表达等;不要编造文本里没有的内容。\n\
只返回 JSON,不要 markdown 代码块,不要解释。JSON 格式:\n\
{\n\
  \"segments\": [\n\
    {\n\
      \"index\": 0,\n\
      \"translation_zh\": \"自然中文翻译\",\n\
      \"grammar_points\": [\n\
        {\"title\": \"语法名\", \"explanation_zh\": \"简短说明\", \"evidence\": \"原文片段\", \"tip_zh\": \"识别/使用提示\"}\n\
      ],\n\
      \"usage_points\": [\n\
        {\"phrase\": \"固定用法或搭配\", \"meaning_zh\": \"中文含义\", \"note_zh\": \"用法说明\", \"example\": \"原文或微改例句\"}\n\
      ]\n\
    }\n\
  ]\n\
}";

const STUDY_BATCH_SIZE: usize = 8;
const STUDY_BATCH_CHAR_LIMIT: usize = 5_000;
const STUDY_TIMEOUT_SECONDS: u64 = 120;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrammarPoint {
    pub title: String,
    pub explanation_zh: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tip_zh: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsagePoint {
    pub phrase: String,
    pub meaning_zh: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_zh: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SegmentStudyView {
    pub translation_zh: String,
    pub grammar_points: Vec<GrammarPoint>,
    pub usage_points: Vec<UsagePoint>,
}

#[derive(Debug, Deserialize)]
struct StudyBatchResponse {
    segments: Vec<StudySegmentResponse>,
}

#[derive(Debug, Deserialize)]
struct StudySegmentResponse {
    index: usize,
    #[serde(default)]
    translation_zh: String,
    #[serde(default)]
    grammar_points: Vec<GrammarPoint>,
    #[serde(default)]
    usage_points: Vec<UsagePoint>,
}

#[derive(Debug, Serialize)]
struct PromptSegment<'a> {
    index: usize,
    start_ms: i64,
    end_ms: i64,
    text: &'a str,
}

pub async fn generate_segment_studies_for_job(
    pool: &sqlx::SqlitePool,
    llm: &SharedLlm,
    job_id: i64,
) -> Result<()> {
    let segments = load_job_segments(pool, job_id).await?;
    if segments.is_empty() {
        mark_study_skipped(pool, job_id, "no transcript segments").await?;
        return Ok(());
    }
    let material_id = segments[0].material_id;
    let chunks = segment_chunks(&segments);
    let total_chunks = chunks.len();

    let cfg = llm.read().await.clone();
    if !cfg.configured() {
        mark_study_skipped(
            pool,
            job_id,
            "LLM API key not configured; set it on the Settings page",
        )
        .await?;
        return Ok(());
    }

    sqlx::query("DELETE FROM transcript_segment_studies WHERE job_id = ?")
        .bind(job_id)
        .execute(pool)
        .await?;
    update_study_progress(pool, job_id, 1, "准备分析分段").await?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(STUDY_TIMEOUT_SECONDS))
        .build()?;
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));

    for (index, chunk) in chunks.into_iter().enumerate() {
        let current = index + 1;
        let stage = format!("分析第 {current}/{total_chunks} 批");
        update_study_progress(pool, job_id, chunk_progress(index, total_chunks), &stage).await?;
        let response = call_study_llm(&client, &url, &cfg.api_key, &cfg.model, chunk).await?;
        persist_study_batch(pool, job_id, material_id, chunk, response).await?;
        let stage = format!("已完成第 {current}/{total_chunks} 批");
        update_study_progress(pool, job_id, chunk_progress(current, total_chunks), &stage).await?;
    }

    mark_study_succeeded(pool, job_id).await?;
    Ok(())
}

async fn load_job_segments(pool: &sqlx::SqlitePool, job_id: i64) -> Result<Vec<TranscriptSegment>> {
    Ok(sqlx::query_as::<_, TranscriptSegment>(
        "SELECT id, job_id, material_id, start_ms, end_ms, text \
         FROM transcript_segments \
         WHERE job_id = ? \
         ORDER BY start_ms ASC, id ASC",
    )
    .bind(job_id)
    .fetch_all(pool)
    .await?)
}

pub async fn mark_study_failed(pool: &sqlx::SqlitePool, job_id: i64, error: &str) -> Result<()> {
    sqlx::query(
        "UPDATE transcription_jobs \
         SET study_status = 'failed', study_error = ?, study_progress = 100, \
             study_stage = '分析失败', updated_at = ? \
         WHERE id = ?",
    )
    .bind(error.chars().take(2000).collect::<String>())
    .bind(Utc::now())
    .bind(job_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub fn parse_study_view(
    segment_id: i64,
    translation_zh: Option<String>,
    grammar_points: Option<String>,
    usage_points: Option<String>,
) -> Option<SegmentStudyView> {
    let translation_zh = translation_zh.unwrap_or_default();
    if translation_zh.trim().is_empty() && grammar_points.is_none() && usage_points.is_none() {
        return None;
    }
    Some(SegmentStudyView {
        translation_zh,
        grammar_points: parse_json_vec(segment_id, "grammar_points", grammar_points),
        usage_points: parse_json_vec(segment_id, "usage_points", usage_points),
    })
}

async fn call_study_llm(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    model: &str,
    segments: &[TranscriptSegment],
) -> Result<StudyBatchResponse> {
    let prompt_segments = segments
        .iter()
        .enumerate()
        .map(|(index, segment)| PromptSegment {
            index,
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            text: segment.text.as_str(),
        })
        .collect::<Vec<_>>();
    let user_prompt = format!(
        "请分析以下英文听力分段。每个输入 index 都必须在输出中出现一次;如果某段没有明显语法或固定搭配,对应数组返回 []。\nsegments:\n{}",
        serde_json::to_string(&prompt_segments)?
    );

    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": user_prompt }
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.2
    });

    let res = client
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .context("segment study LLM request failed")?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        let trimmed = text.chars().take(500).collect::<String>();
        return Err(anyhow!("segment study LLM returned {status}: {trimmed}"));
    }

    let raw: serde_json::Value = res.json().await.context("invalid LLM response JSON")?;
    let content = raw
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|s| s.as_str())
        .ok_or_else(|| anyhow!("segment study LLM response missing message.content"))?;
    let parsed = parse_batch_response(content)?;

    if parsed.segments.len() != segments.len() {
        return Err(anyhow!(
            "segment study LLM returned {} segments, expected {}",
            parsed.segments.len(),
            segments.len()
        ));
    }
    Ok(parsed)
}

async fn persist_study_batch(
    pool: &sqlx::SqlitePool,
    job_id: i64,
    material_id: i64,
    segments: &[TranscriptSegment],
    response: StudyBatchResponse,
) -> Result<()> {
    let now = Utc::now();
    let mut by_index = response
        .segments
        .into_iter()
        .map(|item| (item.index, item))
        .collect::<std::collections::HashMap<_, _>>();
    let mut tx = pool.begin().await?;

    for (index, segment) in segments.iter().enumerate() {
        let item = by_index
            .remove(&index)
            .ok_or_else(|| anyhow!("segment study LLM omitted index {index}"))?;
        let translation_zh = trim_to(item.translation_zh, 2000);
        if translation_zh.is_empty() {
            return Err(anyhow!(
                "segment study LLM returned empty translation for index {index}"
            ));
        }
        let grammar_points = serde_json::to_string(&clean_grammar_points(item.grammar_points))?;
        let usage_points = serde_json::to_string(&clean_usage_points(item.usage_points))?;
        sqlx::query(
            "INSERT INTO transcript_segment_studies \
             (segment_id, job_id, material_id, translation_zh, grammar_points, usage_points, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(segment_id) DO UPDATE SET \
               translation_zh = excluded.translation_zh, \
               grammar_points = excluded.grammar_points, \
               usage_points = excluded.usage_points, \
               updated_at = excluded.updated_at",
        )
        .bind(segment.id)
        .bind(job_id)
        .bind(material_id)
        .bind(translation_zh)
        .bind(grammar_points)
        .bind(usage_points)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn mark_study_running(pool: &sqlx::SqlitePool, job_id: i64) -> Result<()> {
    sqlx::query(
        "UPDATE transcription_jobs \
         SET study_status = 'running', study_error = NULL, study_progress = 0, \
             study_stage = '等待开始', updated_at = ? \
         WHERE id = ?",
    )
    .bind(Utc::now())
    .bind(job_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_study_succeeded(pool: &sqlx::SqlitePool, job_id: i64) -> Result<()> {
    sqlx::query(
        "UPDATE transcription_jobs \
         SET study_status = 'succeeded', study_error = NULL, study_progress = 100, \
             study_stage = '分析完成', updated_at = ? \
         WHERE id = ?",
    )
    .bind(Utc::now())
    .bind(job_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_study_skipped(pool: &sqlx::SqlitePool, job_id: i64, reason: &str) -> Result<()> {
    sqlx::query(
        "UPDATE transcription_jobs \
         SET study_status = 'skipped', study_error = ?, study_progress = 100, \
             study_stage = '已跳过', updated_at = ? \
         WHERE id = ?",
    )
    .bind(reason.chars().take(2000).collect::<String>())
    .bind(Utc::now())
    .bind(job_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn update_study_progress(
    pool: &sqlx::SqlitePool,
    job_id: i64,
    progress: i64,
    stage: &str,
) -> Result<()> {
    sqlx::query(
        "UPDATE transcription_jobs \
         SET study_progress = ?, study_stage = ?, updated_at = ? \
         WHERE id = ? AND study_status = 'running'",
    )
    .bind(progress.clamp(0, 99))
    .bind(stage.chars().take(200).collect::<String>())
    .bind(Utc::now())
    .bind(job_id)
    .execute(pool)
    .await?;
    Ok(())
}

fn chunk_progress(completed_chunks: usize, total_chunks: usize) -> i64 {
    if total_chunks == 0 {
        return 0;
    }
    let progress = ((completed_chunks as f64 / total_chunks as f64) * 96.0).round() as i64;
    progress.clamp(1, 96)
}

fn segment_chunks(segments: &[TranscriptSegment]) -> Vec<&[TranscriptSegment]> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut chars = 0;
    for (index, segment) in segments.iter().enumerate() {
        let segment_chars = segment.text.chars().count();
        let would_exceed_size = index > start && index - start >= STUDY_BATCH_SIZE;
        let would_exceed_chars = index > start && chars + segment_chars > STUDY_BATCH_CHAR_LIMIT;
        if would_exceed_size || would_exceed_chars {
            chunks.push(&segments[start..index]);
            start = index;
            chars = 0;
        }
        chars += segment_chars;
    }
    if start < segments.len() {
        chunks.push(&segments[start..]);
    }
    chunks
}

fn parse_batch_response(content: &str) -> Result<StudyBatchResponse> {
    if let Ok(parsed) = serde_json::from_str::<StudyBatchResponse>(content) {
        return Ok(parsed);
    }
    let start = content
        .find('{')
        .ok_or_else(|| anyhow!("segment study LLM returned non-JSON content"))?;
    let end = content
        .rfind('}')
        .ok_or_else(|| anyhow!("segment study LLM returned truncated JSON content"))?;
    serde_json::from_str::<StudyBatchResponse>(&content[start..=end])
        .context("segment study LLM returned invalid study JSON")
}

fn parse_json_vec<T>(segment_id: i64, field: &str, raw: Option<String>) -> Vec<T>
where
    T: for<'de> Deserialize<'de>,
{
    let Some(raw) = raw else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<T>>(&raw) {
        Ok(items) => items,
        Err(e) => {
            tracing::warn!(segment_id, field, "failed to parse segment study JSON: {e}");
            Vec::new()
        }
    }
}

fn clean_grammar_points(points: Vec<GrammarPoint>) -> Vec<GrammarPoint> {
    points
        .into_iter()
        .filter_map(|p| {
            let title = trim_to(p.title, 80);
            let explanation_zh = trim_to(p.explanation_zh, 500);
            if title.is_empty() || explanation_zh.is_empty() {
                return None;
            }
            Some(GrammarPoint {
                title,
                explanation_zh,
                evidence: p
                    .evidence
                    .map(|s| trim_to(s, 200))
                    .filter(|s| !s.is_empty()),
                tip_zh: p.tip_zh.map(|s| trim_to(s, 300)).filter(|s| !s.is_empty()),
            })
        })
        .take(4)
        .collect()
}

fn clean_usage_points(points: Vec<UsagePoint>) -> Vec<UsagePoint> {
    points
        .into_iter()
        .filter_map(|p| {
            let phrase = trim_to(p.phrase, 120);
            let meaning_zh = trim_to(p.meaning_zh, 400);
            if phrase.is_empty() || meaning_zh.is_empty() {
                return None;
            }
            Some(UsagePoint {
                phrase,
                meaning_zh,
                note_zh: p.note_zh.map(|s| trim_to(s, 400)).filter(|s| !s.is_empty()),
                example: p.example.map(|s| trim_to(s, 300)).filter(|s| !s.is_empty()),
            })
        })
        .take(5)
        .collect()
}

fn trim_to(value: String, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}
