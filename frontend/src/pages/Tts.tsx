import { useEffect, useRef, useState } from 'react';
import { Loader2, Play, Download, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import AudioPlayer from '../components/AudioPlayer';
import type { MaterialLanguage } from '../types';

const DRAFT_KEY = 'tts-playground-text';
const LANG_KEY = 'tts-playground-language';
const MAX_CHARS = 4000;

type Status = 'idle' | 'loading' | 'ready';

/** Standalone TTS playground: paste any text, listen, optionally download
 *  the MP3. The backend /api/tts/speech endpoint accepts a no-anchor
 *  request and caches at the cache root, so multiple users hitting the
 *  same exact text + language share the cache for free. */
export default function Tts() {
  const [text, setText] = useState(() => localStorage.getItem(DRAFT_KEY) ?? '');
  const [language, setLanguage] = useState<MaterialLanguage>(() => {
    const v = localStorage.getItem(LANG_KEY);
    return v === 'ja' ? 'ja' : 'en';
  });
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, text);
  }, [text]);
  useEffect(() => {
    localStorage.setItem(LANG_KEY, language);
  }, [language]);

  // Blob URL of the most recently fetched audio. AudioPlayer manages
  // its own <audio> element from this URL; we just need to release the
  // URL when it's replaced or the page unmounts.
  const audioUrlRef = useRef<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  function clearAudio() {
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    setAudioUrl(null);
  }

  useEffect(() => clearAudio, []);

  async function fetchAudio(): Promise<Blob> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('请先输入要朗读的文字');
    if (trimmed.length > MAX_CHARS) {
      throw new Error(`文字太长(${trimmed.length} / ${MAX_CHARS} 字符上限)`);
    }
    const res = await fetch('/api/tts/speech', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmed, language }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
      );
    }
    return await res.blob();
  }

  async function onLoadAudio() {
    if (status === 'loading') return;
    clearAudio();
    setError(null);
    setStatus('loading');
    try {
      const blob = await fetchAudio();
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      setAudioUrl(url);
      setStatus('ready');
    } catch (e) {
      setStatus('idle');
      setError((e as Error).message);
    }
  }

  async function onDownload() {
    setError(null);
    try {
      const blob = await fetchAudio();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = makeFilename(text, language);
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser a tick to start the download before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const charCount = text.trim().length;
  const overLimit = charCount > MAX_CHARS;

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="mb-6 flex items-center gap-2">
          <Volume2 className="size-5 text-muted-foreground" />
          <h1 className="text-2xl font-medium tracking-tight text-foreground">
            朗读
          </h1>
        </div>
        <p className="mb-6 text-sm text-muted-foreground">
          粘贴或输入任意文字 → 用 Azure TTS 合成朗读 → 下载 MP3 带走通勤听。
          单次最长 {MAX_CHARS} 字符。
        </p>

        <div className="mb-3 flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">语言</span>
          <div className="flex gap-1 rounded-md border border-border bg-card p-1">
            {(['en', 'ja'] as MaterialLanguage[]).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLanguage(l)}
                className={cn(
                  'rounded px-3 py-1 text-xs transition',
                  language === l
                    ? 'bg-accent text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {l === 'en' ? '英文' : '日文'}
              </button>
            ))}
          </div>
        </div>

        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="在这里粘贴或输入想朗读的文字..."
          className="min-h-[260px] text-[15px] leading-7"
        />

        <div className="mt-3 flex items-center justify-between text-xs">
          <span
            className={cn(
              'text-muted-foreground',
              overLimit && 'font-medium text-destructive',
            )}
          >
            {charCount} / {MAX_CHARS} 字符
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                clearAudio();
                setStatus('idle');
                setText('');
              }}
              disabled={!text}
            >
              清空
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onDownload}
              disabled={!charCount || overLimit}
              title="下载 MP3"
            >
              <Download className="size-4" />
              下载 MP3
            </Button>
            <Button
              onClick={onLoadAudio}
              disabled={!charCount || overLimit || status === 'loading'}
              className="min-w-[100px]"
            >
              {status === 'loading' ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  合成中
                </>
              ) : (
                <>
                  <Play className="size-4" />
                  朗读
                </>
              )}
            </Button>
          </div>
        </div>

        {audioUrl && status === 'ready' && (
          <div className="mt-4">
            <AudioPlayer
              src={audioUrl}
              onEnded={() => {
                /* keep the player visible so the user can replay / seek */
              }}
              onClose={() => {
                clearAudio();
                setStatus('idle');
              }}
            />
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
      </div>
    </main>
  );
}

/** Produce a filesystem-safe filename for the download button. Takes
 *  the first 6 trimmed words / chars of the text so the user can tell
 *  multiple downloads apart in their downloads folder. */
function makeFilename(text: string, language: MaterialLanguage): string {
  const stem = text
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .split(/\s+/)
    .slice(0, 6)
    .join(' ')
    .slice(0, 60) || 'tts';
  return `${stem}.${language}.mp3`;
}
