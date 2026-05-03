import { useState } from 'react';
import { speakWord } from '../lib/audio';

interface Props {
  word: string;
  className?: string;
}

export default function SpeakButton({ word, className = '' }: Props) {
  const [busy, setBusy] = useState(false);

  async function onSpeak() {
    if (busy) return;
    setBusy(true);
    try {
      await speakWord(word);
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
      disabled={busy || !word.trim()}
      title="朗读"
      aria-label={`朗读 ${word}`}
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-stone-200 bg-white text-stone-500 hover:border-stone-300 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      <span aria-hidden="true" className="text-[13px] leading-none">
        {busy ? '...' : '▶'}
      </span>
    </button>
  );
}
