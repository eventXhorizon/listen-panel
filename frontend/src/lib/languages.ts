import type { MaterialLanguage, VocabEntry } from '../types';

export interface LanguageAdapter {
  code: MaterialLanguage;
  label: string;
  nativeLabel: string;
  browserTtsLang: string;
  dictionaryAudio: boolean;
  normalizeTerm(term: string): string;
  extractSentence(text: string, offset: number): string;
  highlightText(
    text: string,
    vocab: VocabEntry[],
  ): Array<{ start: number; end: number; entry: VocabEntry }>;
}

export const LANGUAGE_OPTIONS: Array<{
  value: MaterialLanguage;
  label: string;
  hint: string;
}> = [
  {
    value: 'en',
    label: '英语',
    hint: '英语听力、英文字幕、生词音标',
  },
  {
    value: 'ja',
    label: '日语',
    hint: '日语转写、日语查词、日语朗读',
  },
];

const SENTENCE_END = /[.!?。！？…](?=["'"'"\)\]）】」』》〉]?(\s|$))/g;

function findSentenceByPunctuation(text: string, offset: number): string {
  let segStart = 0;
  let m: RegExpExecArray | null;
  SENTENCE_END.lastIndex = 0;
  while ((m = SENTENCE_END.exec(text)) !== null) {
    const segEnd = m.index + 1;
    if (offset < segEnd) {
      return text.slice(segStart, segEnd).trim();
    }
    let next = segEnd;
    while (next < text.length && /\s/.test(text[next])) next++;
    segStart = next;
  }
  return text.slice(segStart).trim();
}

function normalizeEnglishTerm(term: string): string {
  return term.trim().toLowerCase();
}

function normalizeJapaneseTerm(term: string): string {
  return term.trim();
}

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

function englishHighlights(
  text: string,
  vocab: VocabEntry[],
): Array<{ start: number; end: number; entry: VocabEntry }> {
  if (vocab.length === 0) return [];
  const sorted = [...vocab].sort((a, b) => b.word.length - a.word.length);
  const map = new Map<string, VocabEntry>();
  for (const v of sorted) {
    const key = normalizeEnglishTerm(v.word);
    if (key && !map.has(key)) map.set(key, v);
  }
  const escaped = sorted
    .map((v) => v.word.trim())
    .filter(Boolean)
    .map((word) => word.replace(ESCAPE_RE, '\\$&'));
  if (escaped.length === 0) return [];

  let re: RegExp;
  try {
    re = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
  } catch {
    return [];
  }

  const matches: Array<{ start: number; end: number; entry: VocabEntry }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const entry = map.get(normalizeEnglishTerm(m[0]));
    if (!entry) continue;
    matches.push({ start: m.index, end: m.index + m[0].length, entry });
  }
  return matches;
}

function japaneseHighlights(
  text: string,
  vocab: VocabEntry[],
): Array<{ start: number; end: number; entry: VocabEntry }> {
  const candidates = [...vocab]
    .map((entry) => ({ entry, word: entry.word.trim() }))
    .filter((item) => item.word)
    .sort((a, b) => b.word.length - a.word.length);
  const matches: Array<{ start: number; end: number; entry: VocabEntry }> = [];
  const occupied = new Array<boolean>(text.length).fill(false);

  for (const { entry, word } of candidates) {
    let start = text.indexOf(word);
    while (start >= 0) {
      const end = start + word.length;
      let overlaps = false;
      for (let i = start; i < end; i += 1) {
        if (occupied[i]) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) {
        for (let i = start; i < end; i += 1) occupied[i] = true;
        matches.push({ start, end, entry });
      }
      start = text.indexOf(word, end);
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

const adapters: Record<MaterialLanguage, LanguageAdapter> = {
  en: {
    code: 'en',
    label: '英语',
    nativeLabel: 'English',
    browserTtsLang: 'en-US',
    dictionaryAudio: true,
    normalizeTerm: normalizeEnglishTerm,
    extractSentence: findSentenceByPunctuation,
    highlightText: englishHighlights,
  },
  ja: {
    code: 'ja',
    label: '日语',
    nativeLabel: '日本語',
    browserTtsLang: 'ja-JP',
    dictionaryAudio: false,
    normalizeTerm: normalizeJapaneseTerm,
    extractSentence: findSentenceByPunctuation,
    highlightText: japaneseHighlights,
  },
};

export function normalizeLanguage(value: unknown): MaterialLanguage {
  return value === 'ja' ? 'ja' : 'en';
}

export function languageAdapter(value: unknown): LanguageAdapter {
  return adapters[normalizeLanguage(value)];
}

export function languageLabel(value: unknown): string {
  return languageAdapter(value).label;
}
