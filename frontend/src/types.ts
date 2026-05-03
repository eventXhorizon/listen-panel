export type SourceType = 'local' | 'youtube' | 'bilibili';

export interface Material {
  id: number;
  user_id: number;
  title: string;
  source_type: SourceType;
  source_ref: string;
  text: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export type CreateMaterial = Omit<Material, 'id' | 'user_id' | 'created_at' | 'updated_at'>;

export interface MaterialMetadata {
  source_type: Exclude<SourceType, 'local'> | null;
  source_ref: string;
  title?: string | null;
}

export interface VocabEntry {
  id: number;
  word: string;
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

export type CreateVocab = Omit<VocabEntry, 'id' | 'created_at'>;

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
  timeout_seconds: number;
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
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

export interface TranscriptSegment {
  id: number;
  job_id: number;
  material_id: number;
  start_ms: number;
  end_ms: number;
  text: string;
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
