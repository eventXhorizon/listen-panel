import type { MaterialLanguage } from '../types';
import { languageAdapter, normalizeLanguage } from './languages';

interface DictionaryEntry {
  phonetics?: Array<{
    audio?: string;
  }>;
}

const cache = new Map<string, string | null>();

interface TtsProvider {
  name: string;
  speak(text: string, materialId?: number, language?: MaterialLanguage): Promise<boolean>;
}

function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}

// Singleton tracking of "the audio currently playing" so a new speak request
// can stop the previous one instead of letting two clips overlap. Without
// this, clicking a speak button while a clip is mid-flight starts a second
// independent Audio element — the user hears both, talking over each other.
let currentAudio: HTMLAudioElement | null = null;
let currentObjectUrl: string | null = null;

/// Stop any currently playing audio or browser-speech synthesis. Exposed so
/// the speak button can toggle: a click during playback cancels instead of
/// being swallowed by the busy guard.
export function stopSpeech(): void {
  stopCurrentPlayback();
}

function stopCurrentPlayback(): void {
  if (currentAudio) {
    currentAudio.pause();
    // Clearing src releases the buffer; the explicit null assignment lets the
    // listener short-circuit when the matching audio fires its own pause/end.
    currentAudio.src = '';
    currentAudio = null;
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

/// Plays the given Audio element, returning a promise that resolves when
/// playback finishes (or is stopped). Attach listeners before calling play()
/// so a very short clip can't end between play() resolving and the listener
/// being installed.
async function playUntilDone(
  audio: HTMLAudioElement,
  objectUrl: string | null,
): Promise<boolean> {
  const done = new Promise<void>((resolve) => {
    const cleanup = () => {
      if (currentAudio === audio) currentAudio = null;
      if (objectUrl && currentObjectUrl === objectUrl) {
        URL.revokeObjectURL(objectUrl);
        currentObjectUrl = null;
      }
      resolve();
    };
    audio.addEventListener('ended', cleanup, { once: true });
    audio.addEventListener('error', cleanup, { once: true });
    audio.addEventListener('pause', cleanup, { once: true });
  });
  try {
    await audio.play();
  } catch {
    if (currentAudio === audio) currentAudio = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (objectUrl && currentObjectUrl === objectUrl) currentObjectUrl = null;
    return false;
  }
  await done;
  return true;
}

async function fetchDictionaryAudio(word: string): Promise<string | null> {
  const key = normalizeWord(word);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key) ?? null;

  try {
    const res = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`,
    );
    if (!res.ok) {
      cache.set(key, null);
      return null;
    }

    const entries = (await res.json()) as DictionaryEntry[];
    const audio =
      entries
        .flatMap((entry) => entry.phonetics ?? [])
        .map((phonetic) => phonetic.audio?.trim())
        .find((url): url is string => Boolean(url)) ?? null;
    cache.set(key, audio);
    return audio;
  } catch {
    cache.set(key, null);
    return null;
  }
}

const dictionaryProvider: TtsProvider = {
  name: 'dictionary-mp3',
  async speak(text, _materialId, language) {
    if (!languageAdapter(language).dictionaryAudio) return false;
    const audioUrl = await fetchDictionaryAudio(text);
    if (!audioUrl) return false;
    stopCurrentPlayback();
    const audio = new Audio(audioUrl);
    currentAudio = audio;
    // Dictionary URLs are external HTTPs, not blob: URLs — nothing to revoke.
    return playUntilDone(audio, null);
  },
};

const remoteProvider: TtsProvider = {
  name: 'remote-tts',
  async speak(text, materialId, language) {
    try {
      const body =
        materialId == null
          ? { text, language }
          : { text, material_id: materialId, language };
      const res = await fetch('/api/tts/speech', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // This provider is a graceful-degradation link in the chain: a
        // failure here falls through to browser speech, so the reason would
        // otherwise vanish. Log it so a silent Azure outage (expired key,
        // exhausted quota) is still diagnosable from the console.
        const reason = await res.text().catch(() => '');
        console.warn('[tts] remote synthesis failed:', res.status, reason);
        return false;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      stopCurrentPlayback();
      const audio = new Audio(url);
      currentAudio = audio;
      currentObjectUrl = url;
      return playUntilDone(audio, url);
    } catch {
      return false;
    }
  },
};

const browserSpeechProvider: TtsProvider = {
  name: 'browser-speech',
  async speak(text, _materialId, language) {
    if (
      !('speechSynthesis' in window) ||
      !('SpeechSynthesisUtterance' in window)
    ) {
      return false;
    }

    stopCurrentPlayback();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = languageAdapter(language).browserTtsLang;
    utterance.rate = 0.9;
    const done = new Promise<void>((resolve) => {
      utterance.addEventListener('end', () => resolve(), { once: true });
      utterance.addEventListener('error', () => resolve(), { once: true });
    });
    window.speechSynthesis.speak(utterance);
    await done;
    return true;
  },
};

const providers: TtsProvider[] = [
  remoteProvider,
  dictionaryProvider,
  browserSpeechProvider,
];

export async function speakWord(
  word: string,
  materialId?: number,
  language: MaterialLanguage = 'en',
): Promise<void> {
  const text = word.trim();
  if (!text) return;
  const normalizedLanguage = normalizeLanguage(language);

  for (const provider of providers) {
    if (await provider.speak(text, materialId, normalizedLanguage)) return;
  }

  throw new Error('当前浏览器不支持朗读');
}
