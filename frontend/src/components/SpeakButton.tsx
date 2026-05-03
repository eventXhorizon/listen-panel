import { useState } from 'react';
import { speakWord } from '../lib/audio';

interface Props {
  word: string;
  materialId?: number;
  variant?: 'default' | 'dark';
  className?: string;
}

export default function SpeakButton({
  word,
  materialId,
  variant = 'default',
  className = '',
}: Props) {
  const [busy, setBusy] = useState(false);
  const variantClass =
    variant === 'dark'
      ? 'border-stone-700 bg-stone-800 text-white hover:border-stone-500 hover:bg-stone-700 hover:text-white'
      : 'border-stone-200 bg-white text-stone-500 hover:border-stone-300 hover:text-stone-900';

  async function onSpeak() {
    if (busy) return;
    setBusy(true);
    try {
      await speakWord(word, materialId);
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
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border disabled:cursor-not-allowed disabled:opacity-50 ${variantClass} ${className}`}
    >
      {busy ? (
        <span aria-hidden="true" className="text-[13px] leading-none">
          ...
        </span>
      ) : (
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M11 5 6 9H3v6h3l5 4V5Z" />
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </svg>
      )}
    </button>
  );
}
