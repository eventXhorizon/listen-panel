interface DictionaryEntry {
  phonetics?: Array<{
    audio?: string;
  }>;
}

const cache = new Map<string, string | null>();

interface TtsProvider {
  name: string;
  speak(text: string): Promise<boolean>;
}

function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
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
  async speak(text) {
    const audioUrl = await fetchDictionaryAudio(text);
    if (!audioUrl) return false;
    try {
      const audio = new Audio(audioUrl);
      await audio.play();
      return true;
    } catch {
      return false;
    }
  },
};

const remoteProvider: TtsProvider = {
  name: 'remote-tts',
  async speak(text) {
    try {
      const res = await fetch('/api/tts/speech', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return false;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      const cleanup = () => URL.revokeObjectURL(url);
      audio.addEventListener('ended', cleanup, { once: true });
      audio.addEventListener('error', cleanup, { once: true });
      try {
        await audio.play();
        return true;
      } catch {
        cleanup();
        return false;
      }
    } catch {
      return false;
    }
  },
};

const browserSpeechProvider: TtsProvider = {
  name: 'browser-speech',
  async speak(text) {
    if (
      !('speechSynthesis' in window) ||
      !('SpeechSynthesisUtterance' in window)
    ) {
      return false;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
    return true;
  },
};

const providers: TtsProvider[] = [
  remoteProvider,
  dictionaryProvider,
  browserSpeechProvider,
];

export async function speakWord(word: string): Promise<void> {
  const text = word.trim();
  if (!text) return;

  for (const provider of providers) {
    if (await provider.speak(text)) return;
  }

  throw new Error('当前浏览器不支持朗读');
}
