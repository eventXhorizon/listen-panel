import type {
  CreateMaterial,
  CreateVocab,
  AuthStatus,
  JobWithSegments,
  Material,
  MaterialMetadata,
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

export function getTranscriptionSegments(id: number): Promise<JobWithSegments> {
  return request<JobWithSegments>(`/api/transcriptions/${id}/segments`);
}
