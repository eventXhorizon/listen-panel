import type {
  CreateMaterial,
  CreateMaterialNote,
  CreateQuickNote,
  CreateVocab,
  AsrHealthCheckStatus,
  AuthStatus,
  ClozeDifficulty,
  ClozeExercise,
  ClozeExerciseSummary,
  ClozeGradeResult,
  EssayClassic,
  EssayStyle,
  EssayTranslateResponse,
  ModelEssay,
  ModelEssaySummary,
  JobWithSegments,
  Material,
  MaterialLanguage,
  MaterialNote,
  MaterialMetadata,
  NewsItemSummary,
  NewsSource,
  NewsTopic,
  PolishResult,
  QuickNote,
  TranscriptionJob,
  User,
  VocabEntry,
} from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw await asError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function getOrNull<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (res.status === 404) return null;
  if (!res.ok) throw await asError(res);
  return (await res.json()) as T;
}

async function asError(res: Response): Promise<Error> {
  let msg = `HTTP ${res.status}`;
  try {
    const body = await res.text();
    if (body) {
      try {
        const parsed = JSON.parse(body) as { error?: string };
        msg = parsed.error ?? body.slice(0, 200);
      } catch {
        msg = body.slice(0, 200);
      }
    }
  } catch {
    // keep default
  }
  return new Error(msg);
}

// Materials

export function listMaterials(): Promise<Material[]> {
  return request<Material[]>('/api/materials');
}

export function getMaterial(id: number): Promise<Material | null> {
  return getOrNull<Material>(`/api/materials/${id}`);
}

export function createMaterial(data: CreateMaterial): Promise<Material> {
  return request<Material>('/api/materials', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getMaterialMetadata(sourceRef: string): Promise<MaterialMetadata> {
  return request<MaterialMetadata>('/api/materials/metadata', {
    method: 'POST',
    body: JSON.stringify({ source_ref: sourceRef }),
  });
}

export function updateMaterial(
  id: number,
  data: Partial<CreateMaterial>,
): Promise<Material> {
  return request<Material>(`/api/materials/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteMaterial(id: number): Promise<void> {
  await request<void>(`/api/materials/${id}`, { method: 'DELETE' });
}

// Vocab

export function listVocab(materialId?: number): Promise<VocabEntry[]> {
  const qs = materialId == null ? '' : `?material_id=${materialId}`;
  return request<VocabEntry[]>(`/api/vocab${qs}`);
}

export function createVocab(data: CreateVocab): Promise<VocabEntry> {
  return request<VocabEntry>('/api/vocab', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateVocab(
  id: number,
  patch: Partial<CreateVocab>,
): Promise<VocabEntry> {
  return request<VocabEntry>(`/api/vocab/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export async function deleteVocab(id: number): Promise<void> {
  await request<void>(`/api/vocab/${id}`, { method: 'DELETE' });
}

// News

export function listNews(filters?: {
  language?: MaterialLanguage;
  source?: NewsSource;
  topic?: NewsTopic;
  duration?: 'short' | 'medium' | 'long';
}): Promise<NewsItemSummary[]> {
  const params = new URLSearchParams();
  if (filters?.language) params.set('language', filters.language);
  if (filters?.source) params.set('source', filters.source);
  if (filters?.topic) params.set('topic', filters.topic);
  if (filters?.duration) params.set('duration', filters.duration);
  const qs = params.toString();
  return request<NewsItemSummary[]>(`/api/news${qs ? `?${qs}` : ''}`);
}

export function importNews(id: number): Promise<Material> {
  return request<Material>(`/api/news/${id}/import`, { method: 'POST' });
}

export async function deleteNewsItem(id: number): Promise<void> {
  await request<void>(`/api/news/${id}`, { method: 'DELETE' });
}

// Notes

export function listNotes(materialId?: number): Promise<MaterialNote[]> {
  const qs = materialId == null ? '' : `?material_id=${materialId}`;
  return request<MaterialNote[]>(`/api/notes${qs}`);
}

export function createNote(data: CreateMaterialNote): Promise<MaterialNote> {
  return request<MaterialNote>('/api/notes', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateNote(
  id: number,
  patch: Partial<Pick<CreateMaterialNote, 'anchor_text' | 'anchor_hash' | 'content'>>,
): Promise<MaterialNote> {
  return request<MaterialNote>(`/api/notes/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export async function deleteNote(id: number): Promise<void> {
  await request<void>(`/api/notes/${id}`, { method: 'DELETE' });
}

// Quick notes

export function listQuickNotes(): Promise<QuickNote[]> {
  return request<QuickNote[]>('/api/quick-notes');
}

export function createQuickNote(data: CreateQuickNote): Promise<QuickNote> {
  return request<QuickNote>('/api/quick-notes', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateQuickNote(
  id: number,
  patch: {
    translation_zh?: string;
    highlights?: { phrase: string; meaning_zh: string; usage_note?: string }[];
    grammar?: { point: string; explanation_zh: string }[];
    source?: string | null;
  },
): Promise<QuickNote> {
  return request<QuickNote>(`/api/quick-notes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteQuickNote(id: number): Promise<void> {
  await request<void>(`/api/quick-notes/${id}`, { method: 'DELETE' });
}

// Auth

export function authStatus(): Promise<AuthStatus> {
  return request<AuthStatus>('/api/auth/status');
}

export function setupAccount(data: {
  username: string;
  display_name?: string;
  password: string;
}): Promise<User> {
  return request<User>('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function registerAccount(data: {
  username: string;
  display_name?: string;
  password: string;
}): Promise<User> {
  return request<User>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function login(data: { username: string; password: string }): Promise<User> {
  return request<User>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function logout(): Promise<void> {
  await request<void>('/api/auth/logout', { method: 'POST' });
}

// Transcriptions

export function listTranscriptionJobs(materialId: number): Promise<TranscriptionJob[]> {
  return request<TranscriptionJob[]>(`/api/materials/${materialId}/transcriptions`);
}

export function createTranscriptionJob(materialId: number): Promise<TranscriptionJob> {
  return request<TranscriptionJob>(`/api/materials/${materialId}/transcriptions`, {
    method: 'POST',
  });
}

export function getTranscriptionJob(id: number): Promise<TranscriptionJob> {
  return request<TranscriptionJob>(`/api/transcriptions/${id}`);
}

export function createTranscriptionStudy(id: number): Promise<TranscriptionJob> {
  return request<TranscriptionJob>(`/api/transcriptions/${id}/study`, {
    method: 'POST',
  });
}

export function pauseTranscriptionStudy(id: number): Promise<TranscriptionJob> {
  return request<TranscriptionJob>(`/api/transcriptions/${id}/study/pause`, {
    method: 'POST',
  });
}

export function getTranscriptionSegments(id: number): Promise<JobWithSegments> {
  return request<JobWithSegments>(`/api/transcriptions/${id}/segments`);
}

// Writing practice

export function polishWriting(data: {
  text: string;
  translate_enabled?: boolean;
}): Promise<PolishResult> {
  return request<PolishResult>('/api/writing/polish', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function listWritingHistory(): Promise<PolishResult[]> {
  return request<PolishResult[]>('/api/writing/history');
}

export async function deleteWritingDraft(id: number): Promise<void> {
  await request<void>(`/api/writing/history/${id}`, { method: 'DELETE' });
}

// Cloze practice

export function listClozeCandidates(filters?: {
  topic?: NewsTopic;
  source?: NewsSource;
  difficulty?: number;
}): Promise<NewsItemSummary[]> {
  const params = new URLSearchParams();
  if (filters?.topic) params.set('topic', filters.topic);
  if (filters?.source) params.set('source', filters.source);
  if (filters?.difficulty != null) params.set('difficulty', String(filters.difficulty));
  const qs = params.toString();
  return request<NewsItemSummary[]>(`/api/cloze/news${qs ? `?${qs}` : ''}`);
}

export function createClozeExercise(data: {
  news_id: number;
  difficulty?: ClozeDifficulty;
}): Promise<ClozeExercise> {
  return request<ClozeExercise>('/api/cloze/exercises', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function listClozeExercises(): Promise<ClozeExerciseSummary[]> {
  return request<ClozeExerciseSummary[]>('/api/cloze/exercises');
}

export function getClozeExercise(id: number): Promise<ClozeExercise> {
  return request<ClozeExercise>(`/api/cloze/exercises/${id}`);
}

export function gradeClozeExercise(
  id: number,
  answers: string[],
): Promise<ClozeGradeResult> {
  return request<ClozeGradeResult>(`/api/cloze/exercises/${id}/grade`, {
    method: 'POST',
    body: JSON.stringify({ answers }),
  });
}

export async function deleteClozeExercise(id: number): Promise<void> {
  await request<void>(`/api/cloze/exercises/${id}`, { method: 'DELETE' });
}

// Model essays

export function generateEssay(data: {
  topic: string;
  style?: EssayStyle;
  length?: 'short' | 'medium' | 'long';
}): Promise<ModelEssay> {
  return request<ModelEssay>('/api/essays/generate', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function fetchEssayFromUrl(data: {
  url: string;
  author_hint?: string;
  style?: EssayStyle;
  video_url?: string;
}): Promise<ModelEssay> {
  return request<ModelEssay>('/api/essays/fetch', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function importManualEssay(data: {
  text: string;
  title?: string;
  author?: string;
  source_url?: string;
  style?: EssayStyle;
  video_url?: string;
}): Promise<ModelEssay> {
  return request<ModelEssay>('/api/essays/manual', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function listEssays(): Promise<ModelEssaySummary[]> {
  return request<ModelEssaySummary[]>('/api/essays');
}

export function getEssay(id: number): Promise<ModelEssay> {
  return request<ModelEssay>(`/api/essays/${id}`);
}

export async function deleteEssay(id: number): Promise<void> {
  await request<void>(`/api/essays/${id}`, { method: 'DELETE' });
}

export function listEssayClassics(): Promise<EssayClassic[]> {
  return request<EssayClassic[]>('/api/essays/classics');
}

export function translateEssay(id: number): Promise<EssayTranslateResponse> {
  return request<EssayTranslateResponse>(`/api/essays/${id}/translate`, {
    method: 'POST',
  });
}

// Settings

export function checkAsrHealth(data: {
  base_url?: string;
  api_token?: string;
}): Promise<AsrHealthCheckStatus> {
  return request<AsrHealthCheckStatus>('/api/settings/asr/health-check', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}
