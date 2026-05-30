import type { LlmProvider, MaterialLanguage } from '../types';

export interface LookupResult {
  lemma: string;
  phonetic?: string;
  pos?: string;
  definition_zh: string;
  definition_en?: string;
  example_zh?: string;
  /** Which LLM provider produced this result (DeepSeek primary vs configured fallback). */
  provider?: LlmProvider;
}

export interface TranslateResult {
  translation_zh: string;
  provider?: LlmProvider;
}

async function postLlm<T>(url: string, payload: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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
  return (await res.json()) as T;
}

export async function lookupWord(
  word: string,
  context: string,
  language: MaterialLanguage = 'en',
): Promise<LookupResult> {
  return postLlm<LookupResult>('/api/lookup', { word, context, language });
}

/** Paragraph-aware Chinese translation of any source text. Side-effect free. */
export async function translateText(
  text: string,
  language: MaterialLanguage = 'en',
): Promise<TranslateResult> {
  return postLlm<TranslateResult>('/api/translate', { text, language });
}
