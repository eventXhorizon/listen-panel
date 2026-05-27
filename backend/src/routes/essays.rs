//! Model essay library: high-quality English writing the user studies to
//! build input before producing their own output.
//!
//! Three ingestion paths, all feeding the same `model_essays` table:
//!
//!   POST /api/essays/generate  — LLM writes a fresh essay from a topic +
//!                                style brief
//!   POST /api/essays/fetch     — fetch a URL, strip script/style, hand
//!                                to the LLM to extract clean article body
//!                                + analyze
//!   POST /api/essays/manual    — user pastes their own text, LLM only
//!                                analyzes (no extraction step)
//!
//! Plus the usual CRUD:
//!   GET  /api/essays           — list current user's essays (summary, no body)
//!   GET  /api/essays/:id       — one essay with full body + analysis
//!   DELETE /api/essays/:id     — remove one
//!   GET  /api/essays/classics  — hardcoded "must-read" URL list, served so
//!                                the UI can show 一键导入 buttons
//!
//! User isolation is enforced via `WHERE user_id = ?` on every read.

use anyhow::Context;
use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::SqlitePool;

use crate::auth::CurrentUser;
use crate::config::SharedLlm;
use crate::error::{AppError, Result};
use crate::language;
use crate::llm_call::{LlmProvider, call_chat_completions};

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/essays", get(list).post(create_manual_compat))
        .route("/essays/generate", post(generate))
        .route("/essays/fetch", post(fetch_from_url))
        .route("/essays/manual", post(manual))
        .route("/essays/classics", get(classics))
        .route("/essays/:id", get(get_one).delete(remove))
}

const MAX_MANUAL_CHARS: usize = 50_000;
// Cap raw HTML we ship to the LLM. Big enough for ~30k token articles
// (Atlantic features, PG long essays); past this we truncate from the
// tail (assume the body comes first, footer/recommendations come last).
const MAX_HTML_FOR_LLM: usize = 60_000;

/// Long-running LLM calls (article extraction, essay generation) routinely
/// run 30-90 seconds when the output is several thousand tokens. The shared
/// `state.http` client uses a 20s timeout which is sized for snappy lookups,
/// not for heavy generation — past 20s its body-read times out and reqwest
/// surfaces it as "error decoding response body" with no upstream signal.
/// Mirrors `study.rs` which solved the same problem the same way.
const LLM_TIMEOUT_SECS: u64 = 180;

fn build_llm_http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(LLM_TIMEOUT_SECS))
        .build()
        .map_err(|e| AppError(anyhow::anyhow!("build llm http client: {e}")))
}

// ============== Types ==============

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LanguagePoint {
    pub phrase: String,
    pub meaning_zh: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_note: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StructureNote {
    pub paragraph_index: usize,
    /// 'thesis' | 'evidence' | 'counter' | 'transition' | 'conclusion'
    /// | 'narrative' | 'analysis' | 'other'
    pub function: String,
    pub summary_zh: String,
}

#[derive(Debug, Serialize)]
pub struct ModelEssay {
    pub id: i64,
    pub title: String,
    pub author: Option<String>,
    pub language: String,
    /// 'llm' | 'web' | 'manual'
    pub source: String,
    pub source_url: Option<String>,
    pub style: String,
    pub topic: Option<String>,
    pub body: String,
    pub word_count: i64,
    pub language_points: Vec<LanguagePoint>,
    pub structure_notes: Vec<StructureNote>,
    pub created_at: String,
    /// Only set on the immediate create response — tells the UI whether
    /// DeepSeek or the Gemini fallback handled the heavy LLM call. Omitted
    /// on list/get since the DB doesn't remember.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<LlmProvider>,
}

#[derive(Debug, Serialize)]
pub struct ModelEssaySummary {
    pub id: i64,
    pub title: String,
    pub author: Option<String>,
    pub language: String,
    pub source: String,
    pub source_url: Option<String>,
    pub style: String,
    pub topic: Option<String>,
    pub word_count: i64,
    pub created_at: String,
}

#[derive(Debug, sqlx::FromRow)]
struct EssayRow {
    id: i64,
    title: String,
    author: Option<String>,
    language: String,
    source: String,
    source_url: Option<String>,
    style: String,
    topic: Option<String>,
    body: String,
    word_count: i64,
    language_points_json: String,
    structure_notes_json: String,
    created_at: String,
}

impl EssayRow {
    fn into_full(self) -> ModelEssay {
        ModelEssay {
            id: self.id,
            title: self.title,
            author: self.author,
            language: self.language,
            source: self.source,
            source_url: self.source_url,
            style: self.style,
            topic: self.topic,
            body: self.body,
            word_count: self.word_count,
            language_points: serde_json::from_str(&self.language_points_json)
                .unwrap_or_default(),
            structure_notes: serde_json::from_str(&self.structure_notes_json)
                .unwrap_or_default(),
            created_at: self.created_at,
            provider: None,
        }
    }

    fn into_summary(self) -> ModelEssaySummary {
        ModelEssaySummary {
            id: self.id,
            title: self.title,
            author: self.author,
            language: self.language,
            source: self.source,
            source_url: self.source_url,
            style: self.style,
            topic: self.topic,
            word_count: self.word_count,
            created_at: self.created_at,
        }
    }
}

// ============== Generate (LLM writes a new essay) ==============

#[derive(Debug, Deserialize)]
pub struct GenerateReq {
    pub topic: String,
    /// 'economist' | 'atlantic' | 'paul_graham' | 'speech' | 'narrative' |
    /// 'op_ed' | 'other'. Unknown values fall back to 'other'.
    #[serde(default)]
    pub style: Option<String>,
    /// 'short' (~250w) | 'medium' (~450w, default) | 'long' (~700w)
    #[serde(default)]
    pub length: Option<String>,
}

async fn generate(
    State(pool): State<SqlitePool>,
    State(_http): State<reqwest::Client>,
    State(llm): State<SharedLlm>,
    user: CurrentUser,
    Json(req): Json<GenerateReq>,
) -> Result<Response> {
    let http = build_llm_http()?;
    let topic = req.topic.trim();
    if topic.is_empty() {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "topic is required" })),
        )
            .into_response());
    }
    if topic.chars().count() > 500 {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "topic too long (max 500 chars)" })),
        )
            .into_response());
    }
    let style = normalize_style(req.style.as_deref());
    let length_hint = match req.length.as_deref() {
        Some("short") => "~250 词,3-4 段",
        Some("long") => "~700 词,5-7 段",
        _ => "~450 词,4-5 段",
    };

    let cfg = llm.read().await.clone();
    let body = json!({
        "messages": [
            { "role": "system", "content": language::essay_generate_system_prompt() },
            { "role": "user",   "content": language::essay_generate_user_prompt(topic, style, length_hint) },
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.7,
        // Essay body + 8-15 language_points + per-paragraph structure_notes
        // easily blows past DeepSeek's 4096-token default. Without this the
        // response truncates mid-JSON and reqwest fails at body decode.
        "max_tokens": 8192,
    });
    let outcome = call_chat_completions(&http, &cfg, body, "essay-generate")
        .await
        .map_err(AppError)?;
    let parsed: LlmEssayOut = serde_json::from_str(&outcome.content)
        .with_context(|| format!("parse essay-generate output: {}", outcome.content))
        .map_err(AppError)?;
    let cleaned = validate_essay(parsed, None).map_err(AppError)?;

    let row = insert(
        &pool,
        InsertParams {
            user_id: user.id,
            title: cleaned.title,
            author: cleaned.author,
            language: "en".to_string(),
            source: "llm".to_string(),
            source_url: None,
            style: style.to_string(),
            topic: Some(topic.to_string()),
            body: cleaned.body,
            word_count: cleaned.word_count,
            language_points_json: cleaned.language_points_json,
            structure_notes_json: cleaned.structure_notes_json,
        },
    )
    .await?;
    let mut essay = row.into_full();
    essay.provider = Some(outcome.provider);
    Ok(Json(essay).into_response())
}

fn normalize_style(s: Option<&str>) -> &'static str {
    match s.map(str::trim) {
        Some("economist") => "economist",
        Some("atlantic") => "atlantic",
        Some("paul_graham") | Some("pg") => "paul_graham",
        Some("speech") => "speech",
        Some("narrative") => "narrative",
        Some("op_ed") | Some("oped") => "op_ed",
        _ => "other",
    }
}

// ============== Fetch from URL ==============

#[derive(Debug, Deserialize)]
pub struct FetchReq {
    pub url: String,
    /// Optional human-readable author override (useful when the page
    /// doesn't expose one and we already know — e.g. classics list).
    #[serde(default)]
    pub author_hint: Option<String>,
    /// Optional style tag override (so classics can be tagged correctly).
    #[serde(default)]
    pub style: Option<String>,
}

async fn fetch_from_url(
    State(pool): State<SqlitePool>,
    State(_http): State<reqwest::Client>,
    State(llm): State<SharedLlm>,
    user: CurrentUser,
    Json(req): Json<FetchReq>,
) -> Result<Response> {
    let url = req.url.trim();
    if url.is_empty() {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "url is required" })),
        )
            .into_response());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "url must start with http:// or https://" })),
        )
            .into_response());
    }

    // Use a fresh client with a sane UA so static blogs (PG) and most
    // public-domain mirrors respond. Some sites still 403 — we surface
    // that as a clean error.
    let resp = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; ListenPanel/1.0; +https://github.com/)")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| AppError(anyhow::anyhow!("build http client: {e}")))?
        .get(url)
        .send()
        .await
        .map_err(|e| AppError(anyhow::anyhow!("fetch failed: {e}")))?;

    let status = resp.status();
    if !status.is_success() {
        return Ok((
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": format!("fetch returned HTTP {}: paywall? blocked UA? try paste mode.", status.as_u16())
            })),
        )
            .into_response());
    }
    let html = resp
        .text()
        .await
        .map_err(|e| AppError(anyhow::anyhow!("read body: {e}")))?;
    let cleaned_html = strip_html_cruft(&html, MAX_HTML_FOR_LLM);
    if cleaned_html.trim().is_empty() {
        return Ok((
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "fetched body was empty after cleanup" })),
        )
            .into_response());
    }

    let http = build_llm_http()?;
    let cfg = llm.read().await.clone();
    let body = json!({
        "messages": [
            { "role": "system", "content": language::essay_analyze_system_prompt() },
            { "role": "user",   "content": language::essay_analyze_user_prompt(&cleaned_html) },
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.2,
        // Output here echoes the full article body verbatim + language points
        // + structure notes. A 1500-word PG essay alone runs ~2k output tokens
        // and the analysis adds another 1-2k — DeepSeek's 4096 default cuts
        // mid-JSON and the response_body decode fails.
        "max_tokens": 8192,
    });
    let outcome = call_chat_completions(&http, &cfg, body, "essay-fetch")
        .await
        .map_err(AppError)?;
    let parsed: LlmEssayOut = serde_json::from_str(&outcome.content)
        .with_context(|| format!("parse essay-fetch output: {}", outcome.content))
        .map_err(AppError)?;
    let cleaned = validate_essay(parsed, req.author_hint.as_deref()).map_err(AppError)?;

    let style = normalize_style(req.style.as_deref());

    let row = insert(
        &pool,
        InsertParams {
            user_id: user.id,
            title: cleaned.title,
            author: cleaned.author,
            language: "en".to_string(),
            source: "web".to_string(),
            source_url: Some(url.to_string()),
            style: style.to_string(),
            topic: None,
            body: cleaned.body,
            word_count: cleaned.word_count,
            language_points_json: cleaned.language_points_json,
            structure_notes_json: cleaned.structure_notes_json,
        },
    )
    .await?;
    let mut essay = row.into_full();
    essay.provider = Some(outcome.provider);
    Ok(Json(essay).into_response())
}

// ============== Manual paste ==============

#[derive(Debug, Deserialize)]
pub struct ManualReq {
    pub text: String,
    /// Optional metadata the user can fill in.
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub style: Option<String>,
}

async fn manual(
    State(pool): State<SqlitePool>,
    State(_http): State<reqwest::Client>,
    State(llm): State<SharedLlm>,
    user: CurrentUser,
    Json(req): Json<ManualReq>,
) -> Result<Response> {
    let http = build_llm_http()?;
    let text = req.text.trim();
    if text.is_empty() {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "text is required" })),
        )
            .into_response());
    }
    if text.chars().count() > MAX_MANUAL_CHARS {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("text too long (max {MAX_MANUAL_CHARS} chars)") })),
        )
            .into_response());
    }

    let cfg = llm.read().await.clone();
    let body = json!({
        "messages": [
            { "role": "system", "content": language::essay_analyze_system_prompt() },
            { "role": "user",   "content": language::essay_analyze_user_prompt(text) },
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.2,
        // Same reason as essay-fetch: response echoes the full body + analysis.
        "max_tokens": 8192,
    });
    let outcome = call_chat_completions(&http, &cfg, body, "essay-manual")
        .await
        .map_err(AppError)?;
    let parsed: LlmEssayOut = serde_json::from_str(&outcome.content)
        .with_context(|| format!("parse essay-manual output: {}", outcome.content))
        .map_err(AppError)?;
    let mut cleaned = validate_essay(parsed, req.author.as_deref()).map_err(AppError)?;
    // User-provided title overrides whatever the LLM came up with.
    if let Some(t) = req.title.as_deref() {
        let t = t.trim();
        if !t.is_empty() {
            cleaned.title = t.to_string();
        }
    }

    let style = normalize_style(req.style.as_deref());

    let row = insert(
        &pool,
        InsertParams {
            user_id: user.id,
            title: cleaned.title,
            author: cleaned.author,
            language: "en".to_string(),
            source: "manual".to_string(),
            source_url: req
                .source_url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            style: style.to_string(),
            topic: None,
            body: cleaned.body,
            word_count: cleaned.word_count,
            language_points_json: cleaned.language_points_json,
            structure_notes_json: cleaned.structure_notes_json,
        },
    )
    .await?;
    let mut essay = row.into_full();
    essay.provider = Some(outcome.provider);
    Ok(Json(essay).into_response())
}

/// Back-compat shim — some clients post directly to /essays for a manual
/// import. We treat it as a manual paste request.
async fn create_manual_compat(
    State(pool): State<SqlitePool>,
    State(http): State<reqwest::Client>,
    State(llm): State<SharedLlm>,
    user: CurrentUser,
    Json(req): Json<ManualReq>,
) -> Result<Response> {
    manual(State(pool), State(http), State(llm), user, Json(req)).await
}

// ============== List / get / delete ==============

async fn list(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
) -> Result<Json<Vec<ModelEssaySummary>>> {
    let rows: Vec<EssayRow> = sqlx::query_as(
        "SELECT id, title, author, language, source, source_url, style, topic, \
                body, word_count, language_points_json, structure_notes_json, created_at \
         FROM model_essays \
         WHERE user_id = ? \
         ORDER BY created_at DESC \
         LIMIT 200",
    )
    .bind(user.id)
    .fetch_all(&pool)
    .await?;
    Ok(Json(rows.into_iter().map(EssayRow::into_summary).collect()))
}

async fn get_one(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<Response> {
    let row: Option<EssayRow> = sqlx::query_as(
        "SELECT id, title, author, language, source, source_url, style, topic, \
                body, word_count, language_points_json, structure_notes_json, created_at \
         FROM model_essays WHERE id = ? AND user_id = ?",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&pool)
    .await?;
    let Some(row) = row else {
        return Ok((StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response());
    };
    Ok(Json(row.into_full()).into_response())
}

async fn remove(
    State(pool): State<SqlitePool>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode> {
    let result = sqlx::query("DELETE FROM model_essays WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&pool)
        .await?;
    if result.rows_affected() == 0 {
        return Ok(StatusCode::NOT_FOUND);
    }
    Ok(StatusCode::NO_CONTENT)
}

// ============== Classics list ==============

#[derive(Debug, Serialize)]
pub struct Classic {
    pub title: &'static str,
    pub author: &'static str,
    pub url: &'static str,
    pub style: &'static str,
    pub blurb: &'static str,
}

/// Hand-picked, non-paywalled classics worth memorizing. UI shows these
/// with 一键导入 buttons that POST to /essays/fetch with the URL + author.
const CLASSICS: &[Classic] = &[
    Classic {
        title: "Do Things That Don't Scale",
        author: "Paul Graham",
        url: "http://paulgraham.com/ds.html",
        style: "paul_graham",
        blurb: "PG 的经典创业 essay。短句、反直觉、直接 — 学怎么把抽象观点说得具体。",
    },
    Classic {
        title: "How to Do Great Work",
        author: "Paul Graham",
        url: "http://paulgraham.com/greatwork.html",
        style: "paul_graham",
        blurb: "怎么做出顶尖工作。结构松散但每段都密集,适合学 sentence-level rhythm。",
    },
    Classic {
        title: "Stanford Commencement Address (2005)",
        author: "Steve Jobs",
        url: "https://news.stanford.edu/2005/06/14/jobs-061505/",
        style: "speech",
        blurb: "三段式演讲。重复 + 排比 + 个人叙事 — 几乎每句都值得背。",
    },
    Classic {
        title: "Politics and the English Language",
        author: "George Orwell",
        url: "https://www.orwellfoundation.com/the-orwell-foundation/orwell/essays-and-other-works/politics-and-the-english-language/",
        style: "op_ed",
        blurb: "英语写作圣经。讲清楚\"如何不写废话\"的祖师爷文。",
    },
    Classic {
        title: "The Gettysburg Address",
        author: "Abraham Lincoln",
        url: "https://www.abrahamlincolnonline.org/lincoln/speeches/gettysburg.htm",
        style: "speech",
        blurb: "272 词的演讲。每一句都是平行结构的范本。",
    },
    Classic {
        title: "I Have a Dream",
        author: "Martin Luther King Jr.",
        url: "https://www.americanrhetoric.com/speeches/mlkihaveadream.htm",
        style: "speech",
        blurb: "民权运动里程碑演讲。重复结构 + 圣经式句法。",
    },
];

async fn classics(_user: CurrentUser) -> Json<Vec<&'static Classic>> {
    Json(CLASSICS.iter().collect())
}

// ============== Helpers ==============

struct InsertParams {
    user_id: i64,
    title: String,
    author: Option<String>,
    language: String,
    source: String,
    source_url: Option<String>,
    style: String,
    topic: Option<String>,
    body: String,
    word_count: i64,
    language_points_json: String,
    structure_notes_json: String,
}

async fn insert(pool: &SqlitePool, p: InsertParams) -> Result<EssayRow> {
    let row: EssayRow = sqlx::query_as(
        "INSERT INTO model_essays \
           (user_id, title, author, language, source, source_url, style, topic, \
            body, word_count, language_points_json, structure_notes_json) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         RETURNING id, title, author, language, source, source_url, style, topic, \
                   body, word_count, language_points_json, structure_notes_json, created_at",
    )
    .bind(p.user_id)
    .bind(&p.title)
    .bind(p.author.as_deref())
    .bind(&p.language)
    .bind(&p.source)
    .bind(p.source_url.as_deref())
    .bind(&p.style)
    .bind(p.topic.as_deref())
    .bind(&p.body)
    .bind(p.word_count)
    .bind(&p.language_points_json)
    .bind(&p.structure_notes_json)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

#[derive(Debug)]
struct CleanedEssay {
    title: String,
    author: Option<String>,
    body: String,
    word_count: i64,
    language_points_json: String,
    structure_notes_json: String,
}

fn validate_essay(raw: LlmEssayOut, author_hint: Option<&str>) -> anyhow::Result<CleanedEssay> {
    let title = raw.title.trim().to_string();
    if title.is_empty() {
        return Err(anyhow::anyhow!("LLM did not provide a title"));
    }
    let body = raw.body.trim().to_string();
    if body.is_empty() {
        return Err(anyhow::anyhow!("LLM did not provide a body"));
    }

    // Author from LLM, with manual override winning (used by classics list).
    let author = author_hint
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| raw.author.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));

    let language_points: Vec<LanguagePoint> = raw
        .language_points
        .into_iter()
        .filter(|p| !p.phrase.trim().is_empty() && !p.meaning_zh.trim().is_empty())
        .map(|p| LanguagePoint {
            phrase: p.phrase.trim().to_string(),
            meaning_zh: p.meaning_zh.trim().to_string(),
            usage_note: p.usage_note.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        })
        .collect();

    // Cross-check structure notes against actual paragraph count. If the
    // LLM under/over-counts we keep whatever notes line up with valid
    // paragraph indices and silently drop the rest — better than failing
    // ingestion over a presentation-only field.
    let paragraph_count = body.split("\n\n").filter(|p| !p.trim().is_empty()).count();
    let structure_notes: Vec<StructureNote> = raw
        .structure_notes
        .into_iter()
        .filter(|n| n.paragraph_index < paragraph_count && !n.summary_zh.trim().is_empty())
        .map(|n| StructureNote {
            paragraph_index: n.paragraph_index,
            function: normalize_function(&n.function),
            summary_zh: n.summary_zh.trim().to_string(),
        })
        .collect();

    let word_count = body
        .split_whitespace()
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .count() as i64;

    Ok(CleanedEssay {
        title,
        author,
        body,
        word_count,
        language_points_json: serde_json::to_string(&language_points)?,
        structure_notes_json: serde_json::to_string(&structure_notes)?,
    })
}

fn normalize_function(f: &str) -> String {
    let lc = f.trim().to_ascii_lowercase();
    match lc.as_str() {
        "thesis" | "evidence" | "counter" | "transition" | "conclusion"
        | "narrative" | "analysis" | "other" => lc,
        // Common LLM synonyms — quietly map.
        "intro" | "introduction" | "opening" => "thesis".to_string(),
        "example" | "examples" | "support" => "evidence".to_string(),
        "rebuttal" | "objection" => "counter".to_string(),
        "ending" | "closing" => "conclusion".to_string(),
        _ => "other".to_string(),
    }
}

/// Lightweight HTML cleanup before handing the page off to the LLM for
/// extraction. We deliberately don't use a full HTML parser:
///
///   - Strip `<script>...</script>` and `<style>...</style>` chunks
///     (script blocks are the largest source of garbage, often >80% of
///     the byte budget)
///   - Strip HTML comments
///   - Drop common noise containers (nav/header/footer/aside) by tag name
///   - Collapse runs of whitespace
///   - Truncate to a hard byte cap so token cost is bounded
///
/// The LLM then does the smart extraction (article body vs sidebar ads).
fn strip_html_cruft(html: &str, max_chars: usize) -> String {
    use std::sync::LazyLock;
    static SCRIPT_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::RegexBuilder::new(r"<script\b[^>]*>.*?</script>")
            .case_insensitive(true)
            .dot_matches_new_line(true)
            .build()
            .unwrap()
    });
    static STYLE_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::RegexBuilder::new(r"<style\b[^>]*>.*?</style>")
            .case_insensitive(true)
            .dot_matches_new_line(true)
            .build()
            .unwrap()
    });
    static COMMENT_RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"<!--.*?-->").unwrap());
    // The `regex` crate is RE2-style and doesn't support backreferences, so
    // we can't write `<(nav|...)>...</\1>` in one shot. Instead, list each
    // noise tag explicitly. These are the containers most likely to wrap
    // navigation, ads, social buttons and footers on news/blog pages.
    static NOISE_BLOCKS: LazyLock<Vec<regex::Regex>> = LazyLock::new(|| {
        ["nav", "header", "footer", "aside", "form", "noscript"]
            .into_iter()
            .map(|tag| {
                regex::RegexBuilder::new(&format!(r"<{tag}\b[^>]*>.*?</{tag}>"))
                    .case_insensitive(true)
                    .dot_matches_new_line(true)
                    .build()
                    .unwrap()
            })
            .collect()
    });
    static WHITESPACE_RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"[ \t\r\f\v]+").unwrap());
    static MULTI_NEWLINE_RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\n{3,}").unwrap());

    let mut s = SCRIPT_RE.replace_all(html, "").into_owned();
    s = STYLE_RE.replace_all(&s, "").into_owned();
    s = COMMENT_RE.replace_all(&s, "").into_owned();
    for re in NOISE_BLOCKS.iter() {
        s = re.replace_all(&s, "").into_owned();
    }
    s = WHITESPACE_RE.replace_all(&s, " ").into_owned();
    s = MULTI_NEWLINE_RE.replace_all(&s, "\n\n").into_owned();
    let s = s.trim().to_string();

    if s.chars().count() <= max_chars {
        return s;
    }
    // Truncate by char count (multi-byte safe). Article body is almost
    // always near the top; the tail tends to be related-posts / footers.
    s.chars().take(max_chars).collect()
}

#[derive(Debug, Deserialize)]
struct LlmEssayOut {
    #[serde(default)]
    title: String,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    language_points: Vec<RawLanguagePoint>,
    #[serde(default)]
    structure_notes: Vec<RawStructureNote>,
}

#[derive(Debug, Deserialize)]
struct RawLanguagePoint {
    #[serde(default)]
    phrase: String,
    #[serde(default)]
    meaning_zh: String,
    #[serde(default)]
    usage_note: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawStructureNote {
    #[serde(default)]
    paragraph_index: usize,
    #[serde(default)]
    function: String,
    #[serde(default)]
    summary_zh: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_html_cruft_drops_scripts_styles_and_noise() {
        let html = r#"
        <html>
          <head><style>body{}</style></head>
          <body>
            <nav>Home About</nav>
            <article>
              <h1>Title</h1>
              <p>Hello world.</p>
              <script>tracker('x');</script>
              <p>Second paragraph.</p>
            </article>
            <footer>Copyright</footer>
          </body>
        </html>
        "#;
        let cleaned = strip_html_cruft(html, 5000);
        assert!(!cleaned.contains("tracker"));
        assert!(!cleaned.contains("Home About"));
        assert!(!cleaned.contains("Copyright"));
        assert!(cleaned.contains("Hello world"));
        assert!(cleaned.contains("Second paragraph"));
    }

    #[test]
    fn strip_html_cruft_truncates_to_cap() {
        let html = "<p>".to_string() + &"x".repeat(20_000) + "</p>";
        let cleaned = strip_html_cruft(&html, 1000);
        assert!(cleaned.chars().count() <= 1000);
    }

    #[test]
    fn validate_drops_oob_structure_notes() {
        let raw = LlmEssayOut {
            title: "T".into(),
            author: None,
            body: "para 1.\n\npara 2.".into(),
            language_points: vec![],
            structure_notes: vec![
                RawStructureNote {
                    paragraph_index: 0,
                    function: "thesis".into(),
                    summary_zh: "提出论点".into(),
                },
                // Out of bounds — only 2 paragraphs, this points at #5.
                RawStructureNote {
                    paragraph_index: 5,
                    function: "evidence".into(),
                    summary_zh: "证据".into(),
                },
            ],
        };
        let cleaned = validate_essay(raw, None).unwrap();
        let notes: Vec<StructureNote> = serde_json::from_str(&cleaned.structure_notes_json).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].paragraph_index, 0);
    }

    #[test]
    fn validate_normalizes_function_synonyms() {
        let raw = LlmEssayOut {
            title: "T".into(),
            author: None,
            body: "p1.\n\np2.\n\np3.".into(),
            language_points: vec![],
            structure_notes: vec![
                RawStructureNote {
                    paragraph_index: 0,
                    function: "Introduction".into(),
                    summary_zh: "x".into(),
                },
                RawStructureNote {
                    paragraph_index: 1,
                    function: "Example".into(),
                    summary_zh: "x".into(),
                },
                RawStructureNote {
                    paragraph_index: 2,
                    function: "ending".into(),
                    summary_zh: "x".into(),
                },
            ],
        };
        let cleaned = validate_essay(raw, None).unwrap();
        let notes: Vec<StructureNote> = serde_json::from_str(&cleaned.structure_notes_json).unwrap();
        assert_eq!(notes[0].function, "thesis");
        assert_eq!(notes[1].function, "evidence");
        assert_eq!(notes[2].function, "conclusion");
    }

    #[test]
    fn validate_counts_words() {
        let raw = LlmEssayOut {
            title: "T".into(),
            author: None,
            body: "One two three.\n\nFour five.".into(),
            language_points: vec![],
            structure_notes: vec![],
        };
        let cleaned = validate_essay(raw, None).unwrap();
        assert_eq!(cleaned.word_count, 5);
    }
}
