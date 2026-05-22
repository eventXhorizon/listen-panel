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
  material_id: number;
  created_at: string;
  mastery: number;
}

export type CreateVocab = Omit<VocabEntry, 'id' | 'created_at' | 'kind'> & {
  kind?: VocabKind;
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
}

export interface TtsStatus {
  configured: boolean;
  provider: 'eleven_labs';
  base_url: string;
  voice_id: string;
  model: string;
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
