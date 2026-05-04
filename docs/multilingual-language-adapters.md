# Multilingual Language Adapters

## Goal

Listen Panel should support multiple learning languages without hard-coding English behavior into ASR, TTS, vocabulary lookup, highlighting, and study analysis. Japanese is the first target after English, but the structure should make later languages a matter of adding an adapter rather than rewriting the reader.

## Design Principle

Language is a material-level domain attribute. A material owns its language, and downstream features inherit from it:

- ASR uses the material language when sending work to the worker.
- TTS cache keys include language so voices and pronunciation data do not collide.
- Vocabulary entries record the language used when the word was saved.
- Lookup prompts and study prompts are selected by language.
- Reader selection, tokenization, sentence extraction, and highlighting are delegated to frontend language adapters.

Global ASR settings keep a language field as a fallback for legacy material records and manual worker testing, but material language takes precedence.

## Supported Languages In V1

| Code | Name | ASR | Browser TTS | Notes |
|---|---|---|---|---|
| `en` | English | `en` | `en-US` | Existing behavior remains the default. |
| `ja` | Japanese | `ja` | `ja-JP` | V1 supports material language, ASR, TTS, lookup, and basic exact highlighter matching. |

Unknown or blank language values normalize to `en`.

## Adapter Responsibilities

### Backend Adapter

Backend language metadata lives in a small module and should provide:

- supported code validation and normalization
- ASR language code
- lookup prompt for vocabulary
- study-analysis prompt
- cache key language part

Backend users:

- `materials` validates and persists material language
- `vocab` persists entry language, defaulting to the material language
- `llm` selects lookup prompt by request language
- `study` selects segment-analysis prompt by transcription job language
- `tts` resolves language from request or material and includes it in cache naming and hashing
- `asr` creates jobs and worker requests using material language

### Frontend Adapter

Frontend language metadata lives in `frontend/src/lib/languages.ts` and should provide:

- language picker options
- display label
- browser TTS language
- Free Dictionary support flag
- text normalization for vocabulary storage and matching
- sentence extraction hook
- highlight matching hook

Frontend users:

- `Editor` shows language selection for new and edited materials
- `Reader` passes material language into selection popup, add-vocab dialog, highlighter, and speak buttons
- `audio` uses browser language fallback and language-aware dictionary support
- `highlight` avoids English word-boundary matching for languages without spaces

## Data Model

V1 adds:

- `materials.language TEXT NOT NULL DEFAULT 'en'`
- `vocab.language TEXT NOT NULL DEFAULT 'en'`

Existing rows are backfilled to `en`. Future migrations may add richer language-specific vocabulary fields such as:

- `reading`
- `romaji`
- `surface_form`
- `conjugation`
- `extra_json`

V1 intentionally reuses the current fields:

- `word`: selected surface form
- `lemma`: dictionary/base form
- `phonetic`: IPA for English, kana/reading for Japanese
- `pos`: part of speech
- `definition_zh`: Chinese explanation
- `definition_en`: English definition for English; optional note for other languages
- `example_zh`: context translation

## Phased Roadmap

### V1: Material Language Pipeline

- Add material and vocabulary language fields.
- Add editor language picker.
- Use material language for ASR worker requests.
- Use language-specific lookup prompts.
- Use language-specific study-analysis prompts.
- Include language in TTS cache keys and filenames.
- Use `en-US` / `ja-JP` browser fallback TTS.
- Disable Free Dictionary fallback outside English.
- Keep Japanese highlighter as exact substring matching.

### V2: Japanese Reader Ergonomics

- Use `Intl.Segmenter('ja', { granularity: 'word' })` for clickable Japanese tokens.
- Prefer tap/click token selection over browser double-click selection.
- Improve context extraction for Japanese punctuation and quotes.
- Add phrase-length guardrails for Japanese selection.

### V3: Rich Japanese Vocabulary

- Add optional vocabulary metadata for reading, romaji, surface form, and conjugation.
- Support lemma-based matching for common inflected forms.
- Add review UI that can test reading, meaning, and original context separately.

### V4: Per-Language TTS Defaults

- Add language-level TTS preferences.
- Allow different default voices per language.
- Keep the `/api/tts/speech` contract stable so providers remain swappable.

### V5: More Languages

Add languages by implementing adapters and prompts first, then improving tokenization and study output where necessary.

## Risks And Constraints

- Japanese segmentation is not reliable with English word-boundary regexes, so V1 must not pretend exact matching handles all Japanese learning flows.
- Changing a material language after saving vocabulary does not automatically migrate old vocabulary entries in V1.
- Free Dictionary audio is English-only in this product path and should not be called for Japanese.
- TTS cache filenames must include language to avoid old English pronunciation cache entries being reused for Japanese or future languages.
