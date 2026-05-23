//! Furigana (ruby) annotation for Japanese transcript segments.
//!
//! After a Japanese material is imported, `generate_for_job` walks its
//! `transcript_segments`, batches them into DeepSeek calls, and writes
//! ruby-annotated HTML back to each row's `text_with_furigana` column.
//!
//! The prompt asks the LLM to annotate only kanji above ~JLPT N3 — common
//! kanji like 日 / 年 / 行く stay bare so the page isn't visually noisy.
//! Output is sanitized server-side: only `<ruby>` and `<rt>` tags survive,
//! everything else is escaped, so the frontend can safely use
//! `dangerouslySetInnerHTML`.

use anyhow::{Context, Result, anyhow};
use serde::Deserialize;
use serde_json::json;
use sqlx::SqlitePool;

use crate::config::SharedLlm;

/// Send 5 segments per call — keeps each request small enough that DeepSeek
/// finishes quickly while amortizing the prompt overhead.
const BATCH_SIZE: usize = 5;

/// Re-annotates every segment of the given job and writes results back.
/// Returns the count of segments successfully annotated.
pub async fn generate_for_job(
    pool: &SqlitePool,
    http: &reqwest::Client,
    llm: &SharedLlm,
    job_id: i64,
) -> Result<usize> {
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id, text FROM transcript_segments WHERE job_id = ? ORDER BY start_ms",
    )
    .bind(job_id)
    .fetch_all(pool)
    .await?;

    if rows.is_empty() {
        return Ok(0);
    }

    let total = rows.len();
    tracing::info!(job_id, total, "furigana: starting");
    let mut done = 0usize;

    for chunk in rows.chunks(BATCH_SIZE) {
        match annotate_batch(http, llm, chunk).await {
            Ok(annotated) => {
                for (id, html) in annotated {
                    if html.trim().is_empty() {
                        continue;
                    }
                    sqlx::query(
                        "UPDATE transcript_segments SET text_with_furigana = ? WHERE id = ?",
                    )
                    .bind(&html)
                    .bind(id)
                    .execute(pool)
                    .await?;
                    done += 1;
                }
            }
            Err(e) => {
                tracing::warn!(job_id, "furigana batch failed: {e:#}");
            }
        }
    }

    tracing::info!(job_id, done, total, "furigana: complete");
    Ok(done)
}

async fn annotate_batch(
    http: &reqwest::Client,
    llm: &SharedLlm,
    segments: &[(i64, String)],
) -> Result<Vec<(i64, String)>> {
    let cfg = llm.read().await.clone();
    if !cfg.configured() {
        return Err(anyhow!("DeepSeek API key not configured"));
    }
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));

    let items: Vec<serde_json::Value> = segments
        .iter()
        .map(|(id, text)| json!({ "id": id, "text": text }))
        .collect();
    let user_msg = serde_json::to_string(&json!({ "segments": items }))?;

    let body = json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": system_prompt() },
            { "role": "user",   "content": user_msg },
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.2,
    });

    let res = http
        .post(&url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
        .context("DeepSeek furigana request")?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        let trimmed: String = text.chars().take(300).collect();
        return Err(anyhow!("DeepSeek {status}: {trimmed}"));
    }

    let raw: serde_json::Value = res.json().await.context("DeepSeek envelope")?;
    let content = raw
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|s| s.as_str())
        .ok_or_else(|| anyhow!("DeepSeek response missing message.content"))?;

    #[derive(Deserialize)]
    struct Resp {
        #[serde(default)]
        segments: Vec<RespItem>,
    }
    #[derive(Deserialize)]
    struct RespItem {
        id: i64,
        #[serde(default)]
        html: String,
    }
    let parsed: Resp =
        serde_json::from_str(content).with_context(|| format!("parse furigana JSON: {content}"))?;

    Ok(parsed
        .segments
        .into_iter()
        .map(|i| (i.id, sanitize_ruby_html(&i.html)))
        .collect())
}

/// Allow only `<ruby>`, `</ruby>`, `<rt>`, `</rt>` tags. Any other `<...>` gets
/// escaped to `&lt;...&gt;`. Pre-existing `&`, `<`, `>` in the text get escaped
/// when they appear outside an allowed tag, so the result is safe for
/// `dangerouslySetInnerHTML`.
pub fn sanitize_ruby_html(input: &str) -> String {
    let allowed: &[&str] = &["<ruby>", "</ruby>", "<rt>", "</rt>"];
    let mut out = String::with_capacity(input.len() + 16);
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'<' {
            let rest = &input[i..];
            if let Some(tag) = allowed.iter().find(|t| rest.starts_with(*t)) {
                out.push_str(tag);
                i += tag.len();
                continue;
            }
            out.push_str("&lt;");
            i += 1;
        } else if c == b'>' {
            out.push_str("&gt;");
            i += 1;
        } else if c == b'&' {
            // Heuristic: only encode bare `&` (not part of an entity already).
            // For our use case (LLM-generated furigana), bare `&` is unlikely.
            out.push_str("&amp;");
            i += 1;
        } else {
            // Copy one UTF-8 char (handle multibyte).
            let ch_len = utf8_char_len(c);
            out.push_str(&input[i..i + ch_len]);
            i += ch_len;
        }
    }
    out
}

fn utf8_char_len(first_byte: u8) -> usize {
    if first_byte < 0x80 {
        1
    } else if first_byte < 0xC0 {
        1 // continuation byte alone — shouldn't happen but be safe
    } else if first_byte < 0xE0 {
        2
    } else if first_byte < 0xF0 {
        3
    } else {
        4
    }
}

fn system_prompt() -> &'static str {
    "あなたは日本語の振り仮名(furigana)注釈アシスタントです。複数の日本語テキスト断片を受け取り、それぞれに ruby (ルビ) 注釈を加えた HTML を返してください。\n\
     \n\
     ルール:\n\
     1. **注釈する漢字は JLPT N3 を超える難読の漢字のみ**。N4-N5 レベルの常用漢字(日・年・月・人・行く・見る・思う など)は素のままにしてください\n\
     2. 専門用語、人名、地名、固有名詞、難読の複合語は積極的に注釈してよい\n\
     3. **語単位で ruby を一つ**にまとめる:「経済産業省」は <ruby>経済産業省<rt>けいざいさんぎょうしょう</rt></ruby> 全体で 1 つ。一字ずつ分解しない\n\
     4. 記号・英数字・かなはそのまま。改行も保持\n\
     5. 入力された文字列を絶対に追加・削除・変更しない。<ruby><rt> タグを挿入するだけ\n\
     \n\
     入力フォーマット:\n\
     {\"segments\":[{\"id\":1,\"text\":\"...\"}, {\"id\":2,\"text\":\"...\"}]}\n\
     \n\
     出力フォーマット(厳格な JSON、Markdown ラップ禁止):\n\
     {\"segments\":[{\"id\":1,\"html\":\"...\"}, {\"id\":2,\"html\":\"...\"}]}\n\
     \n\
     例:\n\
     入力 text: 今日は経済産業省の関係者と会談しました。\n\
     出力 html: 今日は<ruby>経済産業省<rt>けいざいさんぎょうしょう</rt></ruby>の<ruby>関係者<rt>かんけいしゃ</rt></ruby>と<ruby>会談<rt>かいだん</rt></ruby>しました。"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_allowed_tags() {
        let input = "今日は<ruby>経済産業省<rt>けいざいさんぎょうしょう</rt></ruby>です。";
        assert_eq!(sanitize_ruby_html(input), input);
    }

    #[test]
    fn sanitize_strips_disallowed_tags() {
        let input = "<script>alert(1)</script><ruby>漢字<rt>かんじ</rt></ruby>";
        let out = sanitize_ruby_html(input);
        assert!(out.contains("<ruby>漢字<rt>かんじ</rt></ruby>"));
        assert!(out.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(!out.contains("<script"));
    }

    #[test]
    fn sanitize_escapes_bare_brackets() {
        let input = "1 < 2 and 3 > 1";
        assert_eq!(sanitize_ruby_html(input), "1 &lt; 2 and 3 &gt; 1");
    }

    #[test]
    fn sanitize_preserves_multibyte() {
        let input = "<ruby>日本語<rt>にほんご</rt></ruby>";
        assert_eq!(sanitize_ruby_html(input), input);
    }
}
