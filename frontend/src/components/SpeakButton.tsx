import { useState } from 'react';
import { Square, Volume2 } from 'lucide-react';
import type { MaterialLanguage } from '../types';
import { speakWord, stopSpeech } from '../lib/audio';
import { cn } from '@/lib/utils';

interface Props {
  word: string;
  materialId?: number;
  language?: MaterialLanguage;
  variant?: 'default' | 'dark';
  className?: string;
}

export default function SpeakButton({
  word,
  materialId,
  language = 'en',
  variant = 'default',
  className = '',
}: Props) {
  const [busy, setBusy] = useState(false);
  const variantClass =
    variant === 'dark'
      ? 'border-foreground/30 bg-foreground text-background hover:border-foreground/50 hover:bg-foreground/90'
      : 'border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground';

  async function onSpeak() {
    // Toggle: a click during playback stops, instead of being swallowed by
    // a busy guard. Different buttons each manage their own busy state, but
    // stopSpeech operates on the singleton playback the audio module tracks
    // so any speaker button can stop any in-flight clip.
    if (busy) {
      stopSpeech();
      return;
    }
    setBusy(true);
    try {
      await speakWord(word, materialId, language);
    } catch (e) {
      alert(e instanceof Error ? e.message : '朗读失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSpeak();
      }}
      disabled={!word.trim()}
      title={busy ? '停止朗读' : '朗读'}
      aria-label={busy ? `停止朗读 ${word}` : `朗读 ${word}`}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        variantClass,
        className,
      )}
    >
      {busy ? (
        <Square aria-hidden="true" className="size-3 fill-current" />
      ) : (
        <Volume2 aria-hidden="true" className="size-3.5" />
      )}
    </button>
  );
}
