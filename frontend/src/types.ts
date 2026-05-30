export type SourceType = 'local' | 'youtube' | 'bilibili';
export type MaterialLanguage = 'en' | 'ja';
export type MaterialTextSource = 'manual' | 'manual_subtitle' | 'auto_subtitle' | 'asr';

export interface Material {
  id: number;
  user_id: number;
  title: string;
  language: MaterialLanguage;
  source_type: SourceType;
  source_ref: string;
  text: string;
  text_source: MaterialTextSource;
  notes: string;
  created_at: string;
  updated_at: string;
}

export type CreateMaterial = Pick<
  Material,
  'title' | 'language' | 'source_type' | 'source_ref' | 'text' | 'notes'
>;

export interface MaterialMetadata {
  source_type: Exclude<SourceType, 'local'> | null;
  source_ref: string;
  title?: string | null;
  bilibili?: {
    bvid: string;
    page: number;
    page_count: number;
    aid?: number | null;
    cid?: number | null;
    duration?: number | null;
    total_duration?: number | null;
    part?: string | null;
  } | null;
}

export type VocabKind = 'word' | 'idiom';

export interface VocabEntry {
  id: number;
  /** Always present. Vocab now owns its ownership via user_id; the
   *  material_id / essay_id below are only context anchors. */
  user_id: number;
  word: string;
  language: MaterialLanguage;
  kind: VocabKind;
  lemma: string;
  phonetic?: string;
  pos?: string;
  definition_zh: string;
  definition_en?: string;
  example_zh?: string;
  context: string;
  /** Exactly one of material_id / essay_id is set. */
  material_id?: number | null;
  essay_id?: number | null;
  created_at: string;
  mastery: number;
}

export type CreateVocab = Omit<
  VocabEntry,
  'id' | 'created_at' | 'kind' | 'user_id' | 'material_id' | 'essay_id'
> & {
  kind?: VocabKind;
  /** Exactly one of these is required by the backend. */
  material_id?: number;
  essay_id?: number;
};

export type NewsSource =
  | 'cnbc'
  | 'bloomberg'
  | 'wsj'
  | 'ft'
  | 'wbs'
  | 'nikkei'
  | 'pivot'
  | 'newspicks';
export type NewsTopic = 'finance' | 'politics' | 'tech' | 'culture' | 'other';

export interface NewsSegment {
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface NewsIdiom {
  phrase: string;
  anchor_sentence: string;
  meaning_zh: string;
  usage_note?: string | null;
}

export interface NewsItemSummary {
  id: number;
  yt_video_id: string;
  source: NewsSource;
  channel_id: string;
  channel_name: string;
  title: string;
  description: string;
  thumbnail_url?: string | null;
  published_at: string;
  duration_sec: number;
  language: MaterialLanguage;
  topic: NewsTopic;
  difficulty: number;
  has_captions: number; // 0 | 1
  quality?: number | null;
  quality_reason?: string | null;
  view_count?: number | null;
  fetched_at: string;
  analyzed_at?: string | null;
}

export type NoteTargetType = 'paragraph' | 'segment';

export interface MaterialNote {
  id: number;
  user_id: number;
  material_id: number;
  material_title?: string | null;
  target_type: NoteTargetType;
  target_id?: number | null;
  paragraph_index?: number | null;
  anchor_text: string;
  anchor_hash: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export type CreateMaterialNote = Omit<
  MaterialNote,
  'id' | 'user_id' | 'created_at' | 'updated_at'
>;

export interface AppSettings {
  default_volume: number; // 0.0 - 1.0
}

export interface LlmStatus {
  configured: boolean;
  base_url: string;
  model: string;
  fallback_configured: boolean;
  fallback_base_url: string;
  fallback_model: string;
}

/**
 * Which provider answered a given LLM query. Surfaced on `/api/lookup`
 * responses and the immediate response from `POST /api/quick-notes` so the
 * UI can show a "DeepSeek" / "Gemini 兜底" badge.
 */
export type LlmProvider = 'primary' | 'fallback';

/** Result of `POST /api/settings/llm/health-check`. */
export interface LlmHealthStatus {
  ok: boolean;
  which: 'primary' | 'fallback';
  base_url: string;
  model: string;
  latency_ms: number;
  status?: number;
  json_mode_ok: boolean;
  content_preview?: string;
  error?: string;
}

export interface TtsStatus {
  configured: boolean;
  provider: 'azure';
  region: string;
  voice_id_en: string;
  voice_id_ja: string;
  output_format: string;
}

export interface AsrStatus {
  configured: boolean;
  provider: 'remote_faster_whisper';
  base_url: string;
  token_configured: boolean;
  backend_base_url: string;
  model: string;
  language: string;
  beam_size: number;
  vad_filter: boolean;
  condition_on_previous_text: boolean;
  high_accuracy: boolean;
  timeout_seconds: number;
}

export interface WorkerEndpointProbe {
  ok: boolean;
  status?: number | null;
  latency_ms: number;
  error?: string | null;
}

export interface WorkerSummary {
  service?: string | null;
  version?: string | null;
  queue?: string | null;
  max_concurrent_jobs?: number | null;
  device?: string | null;
  compute_type?: string | null;
  capabilities: string[];
}

export interface AsrHealthCheckStatus {
  ok: boolean;
  configured: boolean;
  base_url: string;
  token_configured: boolean;
  checked_at: string;
  health: WorkerEndpointProbe;
  capabilities: WorkerEndpointProbe;
  worker?: WorkerSummary | null;
}

export interface DataDirStatus {
  active_dir: string;
  configured_dir?: string | null;
  pending_dir?: string | null;
  source: 'env' | 'config' | 'default';
  restart_required: boolean;
}

export interface TranscriptionJob {
  id: number;
  user_id: number;
  material_id: number;
  provider: string;
  model: string;
  language: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress: number;
  error?: string | null;
  study_status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  study_error?: string | null;
  study_progress: number;
  study_stage: string;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

export interface GrammarPoint {
  title: string;
  explanation_zh: string;
  evidence?: string;
  tip_zh?: string;
}

export interface UsagePoint {
  phrase: string;
  meaning_zh: string;
  note_zh?: string;
  example?: string;
}

export interface SegmentStudy {
  translation_zh: string;
  grammar_points: GrammarPoint[];
  usage_points: UsagePoint[];
}

export interface TranscriptSegment {
  id: number;
  job_id: number;
  material_id: number;
  start_ms: number;
  end_ms: number;
  text: string;
  /** Ruby-annotated HTML for Japanese segments. Falls back to `text` when absent. */
  text_with_furigana?: string;
  study?: SegmentStudy;
}

export interface JobWithSegments {
  job: TranscriptionJob;
  segments: TranscriptSegment[];
}

export interface User {
  id: number;
  username: string;
  display_name: string;
  is_admin: boolean;
}

export interface AuthStatus {
  needs_setup: boolean;
  user: User | null;
}

export interface QuickNoteHighlight {
  phrase: string;
  meaning_zh: string;
  usage_note?: string;
}

export interface QuickNoteGrammar {
  point: string;
  explanation_zh: string;
}

export interface QuickNote {
  id: number;
  text: string;
  language: MaterialLanguage;
  translation_zh: string;
  highlights: QuickNoteHighlight[];
  grammar: QuickNoteGrammar[];
  source?: string;
  created_at: string;
  /**
   * Only present on the immediate create response — tells the dialog whether
   * the primary (DeepSeek) or the configured fallback produced the analysis.
   * The DB doesn't remember, so list/get responses omit this field.
   */
  provider?: LlmProvider;
}

export interface CreateQuickNote {
  text: string;
  language: MaterialLanguage;
  source?: string;
}

// ---- Writing practice ----

/** What the local detector decided to do with the input. */
export type WritingAction = 'polish' | 'translate' | 'skip';

export interface PolishTip {
  original: string;
  corrected: string;
  explanation_zh: string;
}

/**
 * Result of one writing-practice submission. The `action` tag discriminates
 * which fields are populated:
 *   - 'polish'    → tips + rewrite  (and id, created_at, provider)
 *   - 'translate' → translation     (and id, created_at, provider)
 *   - 'skip'      → only skip_reason  (no DB row was created)
 */
export interface PolishResult {
  action: WritingAction;
  id: number | null;
  original: string;
  tips?: PolishTip[];
  rewrite?: string;
  translation?: string;
  provider?: LlmProvider;
  created_at?: string;
  skip_reason?: string;
}

// ---- Cloze (fill-in-the-blank) practice ----

export type ClozeCategory =
  // Lexical
  | 'word'
  | 'phrase'
  | 'idiom'
  | 'collocation'
  // Grammar — common pain points for Chinese-native English learners
  | 'preposition'
  | 'article'
  | 'connective'
  | 'verb_form'
  | 'modal';
export type ClozeDifficulty = 'easy' | 'normal' | 'hard';
export type ClozeBlankStatus = 'correct' | 'close' | 'wrong' | 'empty';

export interface ClozeBlank {
  answer: string;
  category: ClozeCategory;
  hint?: string;
  explanation_zh: string;
}

export interface ClozeLastAttempt {
  answers: string[];
  score: number; // 0.0..1.0
  graded_at: string;
}

export interface ClozeExercise {
  id: number;
  news_id: number;
  source_title: string;
  source_topic: NewsTopic;
  source_language: MaterialLanguage;
  difficulty: ClozeDifficulty;
  simplified_text: string;
  blanks: ClozeBlank[];
  last_attempt?: ClozeLastAttempt | null;
  created_at: string;
  /** Only set on the create response. */
  provider?: LlmProvider;
}

export interface ClozeExerciseSummary {
  id: number;
  news_id: number;
  source_title: string;
  source_topic: NewsTopic;
  source_language: MaterialLanguage;
  difficulty: ClozeDifficulty;
  blank_count: number;
  last_attempt?: ClozeLastAttempt | null;
  created_at: string;
}

export interface ClozeBlankResult {
  index: number;
  user_answer: string;
  correct_answer: string;
  status: ClozeBlankStatus;
  explanation_zh: string;
}

export interface ClozeGradeResult {
  results: ClozeBlankResult[];
  score: number; // 0.0..1.0
  correct_count: number;
  total_count: number;
}

// ---- Model essays ----

/** Where this essay came from. UI shows a badge so the user can tell
 *  generated text apart from extracted text. */
export type EssaySource = 'llm' | 'web' | 'manual';

export type EssayStyle =
  | 'economist'
  | 'atlantic'
  | 'paul_graham'
  | 'speech'
  | 'narrative'
  | 'op_ed'
  | 'other';

export type EssayParagraphFunction =
  | 'thesis'
  | 'evidence'
  | 'counter'
  | 'transition'
  | 'conclusion'
  | 'narrative'
  | 'analysis'
  | 'other';

export interface EssayLanguagePoint {
  phrase: string;
  meaning_zh: string;
  usage_note?: string;
}

export interface EssayStructureNote {
  paragraph_index: number;
  function: EssayParagraphFunction;
  summary_zh: string;
}

export interface ModelEssay {
  id: number;
  title: string;
  author?: string | null;
  language: MaterialLanguage;
  source: EssaySource;
  source_url?: string | null;
  /** Optional YouTube (etc.) link for delivered speeches. */
  video_url?: string | null;
  style: EssayStyle;
  topic?: string | null;
  body: string;
  word_count: number;
  language_points: EssayLanguagePoint[];
  structure_notes: EssayStructureNote[];
  /** Parallel array to body paragraphs (split on blank lines). Empty
   *  until /api/essays/:id/translate has been called for this essay —
   *  EssayDetail lazy-fires that endpoint on first view. */
  translation_zh: string[];
  created_at: string;
  /** Only set on the create response. */
  provider?: LlmProvider;
  /** Only set on the /fetch response. True when the URL was already in
   *  the user's library — UI uses it to show "已在库中" instead of "导入成功". */
  was_existing?: boolean;
}

export interface ModelEssaySummary {
  id: number;
  title: string;
  author?: string | null;
  language: MaterialLanguage;
  source: EssaySource;
  source_url?: string | null;
  video_url?: string | null;
  style: EssayStyle;
  topic?: string | null;
  word_count: number;
  created_at: string;
}

/** A curated "must-read" entry served by GET /api/essays/classics.
 *  Each entry is a hardcoded URL on the backend; the UI offers a
 *  one-click "导入" that posts to /api/essays/fetch behind the scenes. */
export interface EssayClassic {
  title: string;
  author: string;
  url: string;
  style: EssayStyle;
  blurb: string;
  video_url?: string;
}

/** Response shape of POST /api/essays/:id/translate. */
export interface EssayTranslateResponse {
  id: number;
  translation_zh: string[];
  provider: LlmProvider;
  /** True when the call returned the cached array without re-translating. */
  cached: boolean;
}

/** One word in a pronunciation assessment. `error_type` is Azure's label:
 *  'None' | 'Mispronunciation' | 'Omission' | 'Insertion' | 'UnexpectedBreak'
 *  | 'MissingBreak' | 'Monotone'. */
export interface PhonemeScore {
  phoneme: string;
  accuracy: number | null;
}

export interface PronunciationWord {
  word: string;
  accuracy: number | null;
  error_type: string;
  /** Per-sound (IPA) breakdown — used to point at the exact sounds to fix. */
  phonemes: PhonemeScore[];
}

/** Response shape of POST /api/pronunciation/assess. Scores are 0-100, or null
 *  when Azure couldn't recognize speech (recognition_status != 'Success'). */
export interface PronunciationResult {
  recognition_status: string;
  recognized_text: string;
  accuracy: number | null;
  fluency: number | null;
  completeness: number | null;
  prosody: number | null;
  pron_score: number | null;
  words: PronunciationWord[];
}
