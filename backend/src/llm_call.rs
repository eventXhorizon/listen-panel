//! Shared OpenAI-compatible `chat/completions` caller with fallback.
//!
//! All LLM-using call sites in the app go through here so the
//! primary→fallback decision is in one place. Behavior:
//!
//! * Try primary. If we get a usable response (2xx), return.
//! * If primary errors out in a way that suggests the provider itself is
//!   sick (timeout, connect refused, 5xx, 429), and a fallback provider is
//!   configured, try it once.
//! * If primary returns a 4xx other than 429 (typically 400 bad request or
//!   401/403 bad key), do **not** fall back — the same body/key would fail
//!   again, and bad-request errors are usually a bug on our side worth
//!   surfacing rather than papering over.
//!
//! The body passed in must NOT include `model` — we inject the correct
//! per-provider model.

use anyhow::{Result, anyhow};
use serde::Serialize;
use serde_json::{Value, json};

use crate::config::LlmConfig;

/// Which provider actually produced the response. Surfaced to the UI so the
/// user can tell when DeepSeek is down and they're seeing fallback output.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LlmProvider {
    Primary,
    Fallback,
}

impl LlmProvider {
    /// Bare provider name (no "兜底" suffix). The "兜底" tag is appended at
    /// each callsite when it wants to surface that we switched away from the
    /// primary — keeps the enum value reusable in different sentences.
    pub fn label_zh(self) -> &'static str {
        match self {
            LlmProvider::Primary => "DeepSeek",
            LlmProvider::Fallback => "Gemini",
        }
    }
}

/// Successful LLM response.
pub struct LlmCallOutcome {
    pub provider: LlmProvider,
    /// `choices[0].message.content` (the JSON the model produced, still a
    /// string — caller parses).
    pub content: String,
}

/// One LLM attempt. Returns:
///  * `Ok(content)` — success
///  * `Err((status_opt, msg))` — failure. `status_opt` is `Some(code)` if
///    we got an HTTP response with a non-2xx status; `None` if the request
///    never completed (timeout / connect / DNS / decode).
async fn try_once(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    body: &Value,
) -> std::result::Result<String, (Option<reqwest::StatusCode>, String)> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let mut full_body = body.clone();
    // Inject `model` — caller passes body sans model so we can swap per provider.
    if let Some(obj) = full_body.as_object_mut() {
        obj.insert("model".to_string(), json!(model));
    }

    let res = match client.post(&url).bearer_auth(api_key).json(&full_body).send().await {
        Ok(r) => r,
        Err(e) => {
            // Network-level failure: timeout, connect refused, DNS, etc.
            return Err((None, format!("{e}")));
        }
    };

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        let trimmed: String = text.chars().take(300).collect();
        return Err((Some(status), format!("HTTP {status}: {trimmed}")));
    }

    let raw: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => return Err((None, format!("response decode: {e}"))),
    };
    let content = raw
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    match content {
        Some(s) => Ok(salvage_json(&s)),
        None => Err((None, "response missing choices[0].message.content".to_string())),
    }
}

/// Returns the input string unchanged if it already parses as JSON. Otherwise
/// tries to pull a balanced JSON object out of it and returns that. If
/// nothing salvageable is in there, returns the original (so downstream
/// `serde_json::from_str` produces the real error).
///
/// Why this exists: Gemini's OpenAI-compatible endpoint (and to a lesser
/// extent some other Chinese providers) honors `response_format: json_object`
/// loosely — the model still wraps the JSON in commentary like
/// `Here is the JSON requested: { … }` or in a `\`\`\`json` fence. The five
/// LLM callers in this app all `serde_json::from_str` the content and choke
/// on prose. Salvaging here transparently fixes every callsite at once.
pub fn salvage_json(raw: &str) -> String {
    if serde_json::from_str::<Value>(raw).is_ok() {
        return raw.to_string();
    }
    match extract_balanced_object(raw) {
        Some(slice) => slice.to_string(),
        None => raw.to_string(),
    }
}

/// Walks `text` looking for a balanced top-level `{ … }` object. Brace
/// counting respects double-quoted strings so a `{` inside a JSON string
/// doesn't push depth.
pub fn extract_balanced_object(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let start = text.find('{')?;
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape = false;
    for (i, &c) in bytes.iter().enumerate().skip(start) {
        if escape {
            escape = false;
            continue;
        }
        if in_string {
            match c {
                b'\\' => escape = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match c {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn salvages_gemini_style_prose_prefix() {
        let raw = "Here is the JSON requested:\n\n{\"ok\": true}";
        assert_eq!(salvage_json(raw), "{\"ok\": true}");
    }

    #[test]
    fn salvages_markdown_fence_wrap() {
        let raw = "```json\n{\"a\": 1, \"b\": \"x\"}\n```";
        assert_eq!(salvage_json(raw), "{\"a\": 1, \"b\": \"x\"}");
    }

    #[test]
    fn leaves_clean_json_untouched() {
        let raw = "{\"lemma\":\"run\",\"definition_zh\":\"跑步\"}";
        assert_eq!(salvage_json(raw), raw);
    }

    #[test]
    fn handles_braces_inside_strings() {
        // The closing `}` inside the string must not end depth tracking.
        let raw = "prose {\"note\":\"contains } a brace\",\"ok\":true} trailing";
        assert_eq!(
            salvage_json(raw),
            "{\"note\":\"contains } a brace\",\"ok\":true}"
        );
    }

    #[test]
    fn handles_escaped_quotes_inside_strings() {
        let raw = "intro {\"q\":\"she said \\\"hi\\\"\",\"ok\":true} outro";
        assert_eq!(
            salvage_json(raw),
            "{\"q\":\"she said \\\"hi\\\"\",\"ok\":true}"
        );
    }

    #[test]
    fn returns_original_when_no_braces() {
        let raw = "just prose, no JSON here";
        assert_eq!(salvage_json(raw), raw);
    }
}

/// Decide whether the primary's failure is one we should retry on the
/// fallback provider. Conservative on purpose — bad requests / bad keys
/// won't get better by switching providers.
fn should_fallback(status: Option<reqwest::StatusCode>) -> bool {
    match status {
        // Network error (no HTTP response) — almost always worth trying
        // the other provider.
        None => true,
        // 5xx upstream issue.
        Some(s) if s.is_server_error() => true,
        // 429 rate limit.
        Some(s) if s.as_u16() == 429 => true,
        // 4xx (incl. 400 / 401 / 403 / 404) — don't fallback.
        Some(_) => false,
    }
}

/// Run the call. `body_without_model` is a normal OpenAI-format
/// chat/completions JSON object **minus** the `model` field — this helper
/// injects the per-provider model.
pub async fn call_chat_completions(
    client: &reqwest::Client,
    cfg: &LlmConfig,
    body_without_model: Value,
    context_label: &str,
) -> Result<LlmCallOutcome> {
    if !cfg.configured() {
        return Err(anyhow!(
            "{context_label}: primary LLM not configured (set DeepSeek API key in Settings)"
        ));
    }

    // 1) Primary.
    match try_once(
        client,
        &cfg.base_url,
        &cfg.api_key,
        &cfg.model,
        &body_without_model,
    )
    .await
    {
        Ok(content) => {
            return Ok(LlmCallOutcome {
                provider: LlmProvider::Primary,
                content,
            });
        }
        Err((status, primary_msg)) => {
            let try_fb = should_fallback(status) && cfg.fallback_configured();
            if !try_fb {
                // Either it's a 4xx-not-429 (real client error), or no
                // fallback is configured. Propagate the primary error as-is.
                let where_ = match status {
                    Some(s) => format!("{} {}", LlmProvider::Primary.label_zh(), s),
                    None => format!("{} (network)", LlmProvider::Primary.label_zh()),
                };
                return Err(anyhow!("{context_label} via {where_}: {primary_msg}"));
            }
            tracing::warn!(
                "{context_label}: primary failed ({primary_msg}); trying fallback {}",
                cfg.fallback_base_url
            );

            // 2) Fallback.
            match try_once(
                client,
                &cfg.fallback_base_url,
                &cfg.fallback_api_key,
                &cfg.fallback_model,
                &body_without_model,
            )
            .await
            {
                Ok(content) => Ok(LlmCallOutcome {
                    provider: LlmProvider::Fallback,
                    content,
                }),
                Err((fb_status, fb_msg)) => {
                    let primary_tag = match status {
                        Some(s) => format!("primary {s}"),
                        None => "primary network".to_string(),
                    };
                    let fb_tag = match fb_status {
                        Some(s) => format!("fallback {s}"),
                        None => "fallback network".to_string(),
                    };
                    Err(anyhow!(
                        "{context_label}: both providers failed. {primary_tag}: {primary_msg} | {fb_tag}: {fb_msg}"
                    ))
                }
            }
        }
    }
}

