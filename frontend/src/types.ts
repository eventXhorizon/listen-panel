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
