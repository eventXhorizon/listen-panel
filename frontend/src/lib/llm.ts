import type { MaterialLanguage } from '../types';

export interface LookupResult {
  lemma: string;
  phonetic?: string;
  pos?: string;
  definition_zh: string;
  definition_en?: string;
  example_zh?: string;
}

export async function lookupWord(
  word: string,
  context: string,
  language: MaterialLanguage = 'en',
): Promise<LookupResult> {
  const res = await fetch('/api/lookup', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word, context, language }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.text();
      try {
        const j = JSON.parse(body) as { error?: string };
        msg = j.error ?? body.slice(0, 200);
      } catch {
        msg = body.slice(0, 200) || msg;
      }
    } catch {
      // keep default
    }
    throw new Error(msg);
  }
  return (await res.json()) as LookupResult;
}
