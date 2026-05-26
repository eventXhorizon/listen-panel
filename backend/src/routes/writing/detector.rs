//! Cheap language pre-filter for the writing-practice endpoint.
//!
//! Ported (function for function) from the better-phrase Claude Code hook's
//! `better_phrase/detector.py`. The goal is the same: spend zero LLM tokens
//! on inputs that obviously aren't worth polishing — pure code, single
//! words, Chinese-only with translation off, fenced blocks the user pasted
//! to give context.
//!
//! Algorithm is intentionally regex-based and deterministic so a given
//! prompt always routes the same way.

use std::sync::LazyLock;

use regex::Regex;

static FENCED_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)```.*?```").unwrap());
static INLINE_CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`]*`").unwrap());
static COMMAND_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[/!]").unwrap());
/// Word-like tokens including digits — used to catch code-style identifiers
/// (react18, http2, useState).
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[a-zA-Z0-9]{2,}").unwrap());
/// Letter-only words — used to count "English" words for the prose threshold.
static LETTER_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[a-zA-Z]{2,}").unwrap());
/// Common English function words. If any appears, the input almost
/// certainly contains real prose.
static FUNCTION_WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(the|a|an|is|are|was|were|i|you|we|they|this|that|these|those|how|what|why|when|where|who|do|does|did|have|has|had|can|could|will|would|should|may|might|in|on|at|for|to|of|with|and|or|but|if|so|because|though|while)\b",
    )
    .unwrap()
});
/// CJK Unified Ideographs block (covers all "Chinese" characters we care
/// about for this heuristic — same range as the Python `[一-鿿]`).
static CJK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\u{4E00}-\u{9FFF}]").unwrap());

/// Minimum English words for "this looks like prose". Below this we treat
/// the input as not-prose (single command, identifier, etc).
const MIN_ENGLISH_WORDS: usize = 3;
/// Minimum CJK chars for "this has meaningful Chinese to translate".
const MIN_CJK_CHARS: usize = 5;

/// Tail-only heuristic: when the user clearly pasted something long and
/// added a short typed comment at the end, only the trailing comment is
/// their actual question. The hook can't see paste metadata, so length
/// disparity is the best proxy.
const TAIL_MAX_LEN: usize = 50;
const TAIL_REST_MIN_LEN: usize = 100;

/// Action chosen by the local pre-filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WritingAction {
    /// Run the polish prompt: English prose worth correcting.
    Polish,
    /// Run the translation prompt: Chinese dominant, user opted in.
    Translate,
    /// Don't touch it — no real prose to polish, no Chinese to translate
    /// (or translation is off). Caller should not bill the user for tokens.
    Skip,
}

/// Strip fenced code blocks, slash/bang command lines, and inline backticks.
/// Mirrors `detector.clean()` in the Python source.
pub fn clean(text: &str) -> String {
    let no_fenced = FENCED_BLOCK.replace_all(text, "").to_string();
    let no_commands: String = no_fenced
        .lines()
        .filter(|line| !COMMAND_LINE.is_match(line))
        .collect::<Vec<_>>()
        .join("\n");
    INLINE_CODE.replace_all(&no_commands, "").to_string()
}

/// Returns the slice of `text` that most likely reflects the user's intent.
/// When the trailing segment is much shorter than the body (suggesting
/// "pasted bulk + short typed comment") only the trailing segment is
/// returned. Otherwise the input passes through unchanged.
pub fn extract_user_intent(text: &str) -> &str {
    let segments = split_segments(text);
    if segments.len() < 2 {
        return text;
    }
    let last = segments.last().copied().unwrap();
    let rest_len: usize = segments[..segments.len() - 1]
        .iter()
        .map(|s| s.chars().count())
        .sum();
    if last.chars().count() <= TAIL_MAX_LEN && rest_len >= TAIL_REST_MIN_LEN {
        last
    } else {
        text
    }
}

/// Split `text` into sentence-ish segments by paragraph breaks, line breaks,
/// or sentence-ending punctuation (CJK and English). Yields trimmed,
/// non-empty &str views into the original string.
fn split_segments(text: &str) -> Vec<&str> {
    // Walk char-by-char and cut at each boundary. We keep this as a hand
    // walk (rather than a single regex split) so we can return &str slices
    // back into `text` — which lets `extract_user_intent` return a borrow.
    let bytes = text.as_bytes();
    let mut out: Vec<&str> = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        let is_break = matches!(b, b'\n') || is_sentence_terminator(&text[i..]);
        if is_break {
            let mut end = i;
            // Consume the punctuation/newline itself.
            while end < bytes.len() && (matches!(bytes[end], b'\n') || is_sentence_terminator(&text[end..])) {
                end = next_char_boundary(text, end);
            }
            // Then skip trailing whitespace.
            while end < bytes.len() && (bytes[end] == b' ' || bytes[end] == b'\t') {
                end += 1;
            }
            let seg = text[start..i].trim();
            if !seg.is_empty() {
                out.push(seg);
            }
            start = end;
            i = end;
            continue;
        }
        i = next_char_boundary(text, i);
    }
    let tail = text[start..].trim();
    if !tail.is_empty() {
        out.push(tail);
    }
    out
}

/// True when the next char at `s[0..]` is a sentence terminator we want to
/// split on: `.` `!` `?` (English) or `。` `!` `?` (CJK fullwidth).
fn is_sentence_terminator(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some('.') | Some('!') | Some('?') | Some('。') | Some('！') | Some('？') => true,
        _ => false,
    }
}

fn next_char_boundary(s: &str, i: usize) -> usize {
    let mut j = i + 1;
    while j < s.len() && !s.is_char_boundary(j) {
        j += 1;
    }
    j
}

/// Code-style identifier heuristic. Mirrors the Python helper exactly:
///   - any digit          → code (react18, http2, v5)
///   - long ALL CAPS      → code (HTTP, MAX_CONN)
///   - internal uppercase → code (useState, MyClass)
/// A plain leading-cap word like "Hello" is NOT flagged.
fn looks_like_code_token(word: &str) -> bool {
    if word.chars().any(|c| c.is_ascii_digit()) {
        return true;
    }
    if word.chars().all(|c| c.is_ascii_uppercase()) && word.len() > 2 {
        return true;
    }
    let mut chars = word.chars();
    let _first = chars.next();
    chars.any(|c| c.is_ascii_uppercase())
}

fn has_english_signal(cleaned: &str) -> bool {
    let letter_words: Vec<_> = LETTER_WORD.find_iter(cleaned).collect();
    if letter_words.len() < MIN_ENGLISH_WORDS {
        return false;
    }
    if FUNCTION_WORD.is_match(cleaned) {
        return true;
    }
    let all_tokens: Vec<_> = WORD.find_iter(cleaned).map(|m| m.as_str()).collect();
    if !all_tokens.is_empty() && all_tokens.iter().all(|w| looks_like_code_token(w)) {
        return false;
    }
    true
}

fn cjk_count(s: &str) -> usize {
    CJK.find_iter(s).count()
}

fn english_word_count(s: &str) -> usize {
    LETTER_WORD.find_iter(s).count()
}

/// Decide what to do with a given prompt, given the user's translate
/// setting. Mirrors `detector.route_intent`.
///
/// Mixed-input rule: dominant language wins.
///   - CJK chars > english words * 2  → Chinese-dominant
///   - English signal present         → polish
///   - some Chinese present           → translate (if enabled)
///   - else                           → skip
pub fn route_intent(prompt: &str, translate_enabled: bool) -> WritingAction {
    if prompt.trim().is_empty() {
        return WritingAction::Skip;
    }
    let cleaned = clean(prompt);
    let target = extract_user_intent(&cleaned);

    let en_words = english_word_count(target);
    let cjk_chars = cjk_count(target);
    let has_english = has_english_signal(target);
    let has_chinese = cjk_chars >= MIN_CJK_CHARS;

    if has_chinese && cjk_chars > en_words * 2 {
        if translate_enabled {
            return WritingAction::Translate;
        }
        return if has_english {
            WritingAction::Polish
        } else {
            WritingAction::Skip
        };
    }
    if has_english {
        return WritingAction::Polish;
    }
    if has_chinese && translate_enabled {
        return WritingAction::Translate;
    }
    WritingAction::Skip
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_prose_routes_to_polish() {
        assert_eq!(
            route_intent("I really like coding with Claude", true),
            WritingAction::Polish
        );
        assert_eq!(
            route_intent("I really like coding with Claude", false),
            WritingAction::Polish
        );
    }

    #[test]
    fn chinese_dominant_routes_to_translate_when_enabled() {
        assert_eq!(
            route_intent("我想约客户下周二开会讨论合同细节", true),
            WritingAction::Translate
        );
        assert_eq!(
            route_intent("我想约客户下周二开会讨论合同细节", false),
            WritingAction::Skip
        );
    }

    #[test]
    fn mixed_english_dominant_routes_to_polish() {
        // English-dominant: should polish even with translation on.
        assert_eq!(
            route_intent(
                "I think we should ship this on Monday — 你怎么看?",
                true
            ),
            WritingAction::Polish
        );
    }

    #[test]
    fn fenced_code_only_routes_to_skip() {
        let input = "```\nfn main() {\n    println!(\"hi\");\n}\n```";
        assert_eq!(route_intent(input, true), WritingAction::Skip);
    }

    #[test]
    fn single_short_token_routes_to_skip() {
        assert_eq!(route_intent("ok", true), WritingAction::Skip);
        assert_eq!(route_intent("yes", true), WritingAction::Skip);
    }

    #[test]
    fn code_identifiers_only_routes_to_skip() {
        // All code-style identifiers, no prose words.
        assert_eq!(
            route_intent("useState http2 MyClass HTTP_OK", true),
            WritingAction::Skip
        );
    }

    #[test]
    fn tail_only_picks_short_trailing_comment() {
        // Long pasted body, short typed question at the end.
        let pasted = "x".repeat(200);
        let input = format!("{pasted}\n\nhow does this work");
        // The body is pasted noise; the actual prose comes from the tail.
        // Result depends on the tail's contents — here the tail has English
        // function words so polish wins.
        assert_eq!(route_intent(&input, true), WritingAction::Polish);
    }

    #[test]
    fn empty_input_routes_to_skip() {
        assert_eq!(route_intent("", true), WritingAction::Skip);
        assert_eq!(route_intent("   \n\t  ", true), WritingAction::Skip);
    }

    #[test]
    fn clean_strips_fenced_blocks_and_commands() {
        let input = "look at this:\n```\nsecret code\n```\n/help me out";
        let cleaned = clean(input);
        assert!(!cleaned.contains("secret code"));
        assert!(!cleaned.contains("/help me out"));
        assert!(cleaned.contains("look at this:"));
    }

    #[test]
    fn looks_like_code_token_examples() {
        assert!(looks_like_code_token("react18"));
        assert!(looks_like_code_token("HTTP"));
        assert!(looks_like_code_token("useState"));
        assert!(!looks_like_code_token("Hello"));
        assert!(!looks_like_code_token("the"));
    }
}
