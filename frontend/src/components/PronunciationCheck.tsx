import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Square, X } from 'lucide-react';
import type { MaterialLanguage, PronunciationResult, PronunciationWord } from '../types';
import { assessPronunciation } from '../api';
import {
  isRecordingSupported,
  startRecording,
  type ActiveRecording,
} from '../lib/recorder';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  /** The text the user is meant to read aloud — sent to Azure as the reference. */
  text: string;
  language: MaterialLanguage;
  /** Compact layout for inline use (e.g. inside a Reader segment header). */
  compact?: boolean;
  className?: string;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'recording' }
  | { kind: 'uploading' }
  | { kind: 'result'; result: PronunciationResult }
  | { kind: 'error'; message: string };

const supported = isRecordingSupported();

export default function PronunciationCheck({
  text,
  language,
  compact = false,
  className,
}: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const recordingRef = useRef<ActiveRecording | null>(null);

  // Release the mic if the component unmounts mid-recording.
  useEffect(() => {
    return () => {
      recordingRef.current?.cancel();
      recordingRef.current = null;
    };
  }, []);

  async function onStart() {
    if (!text.trim()) {
      setPhase({ kind: 'error', message: '没有可朗读的文本' });
      return;
    }
    try {
      recordingRef.current = await startRecording();
      setPhase({ kind: 'recording' });
    } catch {
      setPhase({
        kind: 'error',
        message: '无法访问麦克风，请检查浏览器权限',
      });
    }
  }

  async function onStop() {
    const rec = recordingRef.current;
    if (!rec) return;
    recordingRef.current = null;
    setPhase({ kind: 'uploading' });
    try {
      const blob = await rec.stop();
      const result = await assessPronunciation(blob, text, language);
      setPhase({ kind: 'result', result });
    } catch (e) {
      setPhase({
        kind: 'error',
        message: e instanceof Error ? e.message : '发音评估失败',
      });
    }
  }

  function onCancel() {
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setPhase({ kind: 'idle' });
  }

  if (!supported) {
    return (
      <p className={cn('text-xs text-muted-foreground', className)}>
        当前浏览器不支持录音
      </p>
    );
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center gap-2">
        {phase.kind === 'recording' ? (
          <>
            <Button
              type="button"
              size={compact ? 'xs' : 'sm'}
              variant="destructive"
              onClick={onStop}
            >
              <Square className="fill-current" />
              停止并评估
            </Button>
            <Button
              type="button"
              size={compact ? 'icon-xs' : 'icon-sm'}
              variant="ghost"
              onClick={onCancel}
              title="取消"
              aria-label="取消录音"
            >
              <X />
            </Button>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-block size-2 animate-pulse rounded-full bg-destructive" />
              录音中…
            </span>
          </>
        ) : phase.kind === 'uploading' ? (
          <Button type="button" size={compact ? 'xs' : 'sm'} disabled>
            <Loader2 className="animate-spin" />
            评估中…
          </Button>
        ) : (
          <Button
            type="button"
            size={compact ? 'xs' : 'sm'}
            variant="outline"
            onClick={onStart}
          >
            <Mic />
            {phase.kind === 'result' || phase.kind === 'error'
              ? '重新录音'
              : '朗读测评'}
          </Button>
        )}
      </div>

      {phase.kind === 'error' && (
        <p className="text-xs text-destructive">{phase.message}</p>
      )}

      {phase.kind === 'result' && (
        <ResultPanel result={phase.result} compact={compact} />
      )}
    </div>
  );
}

function ResultPanel({
  result,
  compact,
}: {
  result: PronunciationResult;
  compact: boolean;
}) {
  if (result.recognition_status !== 'Success') {
    return (
      <p className="text-xs text-muted-foreground">
        没有识别到清晰的语音，请在安静环境下重试。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-card/50 p-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        <Score label="综合" value={result.pron_score} primary />
        <Score label="准确度" value={result.accuracy} />
        <Score label="流利度" value={result.fluency} />
        <Score label="完整度" value={result.completeness} />
        {result.prosody != null && <Score label="韵律" value={result.prosody} />}
      </div>

      {result.words.length > 0 && (
        <p className={cn('leading-relaxed', compact ? 'text-sm' : 'text-base')}>
          {result.words.map((w, i) => (
            <WordSpan key={`${w.word}-${i}`} word={w} />
          ))}
        </p>
      )}

      <AdviceSection result={result} />

      {result.recognized_text && (
        <p className="text-xs text-muted-foreground">
          识别结果：{result.recognized_text}
        </p>
      )}
    </div>
  );
}

const ERROR_HINT: Record<string, string> = {
  Omission: '漏读',
  Insertion: '多读了',
  UnexpectedBreak: '停顿不自然',
  MissingBreak: '该停顿处没停',
  Monotone: '语调偏平',
};

function AdviceSection({ result }: { result: PronunciationResult }) {
  // Words worth drilling into: a real error, or accuracy below 80. Sorted
  // worst-first so the sounds that need the most work surface at the top.
  const weak = result.words
    .filter(
      (w) =>
        (w.error_type && w.error_type !== 'None') ||
        (w.accuracy != null && w.accuracy < 80),
    )
    .sort((a, b) => (a.accuracy ?? 0) - (b.accuracy ?? 0));

  if (weak.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 rounded-md bg-accent/50 px-3 py-2.5">
      <p className="text-xs font-medium text-foreground">需要练习的词（Azure 实测）</p>
      <ul className="flex flex-col gap-1.5">
        {weak.slice(0, 10).map((w, i) => (
          <WeakWord key={`${w.word}-${i}`} word={w} />
        ))}
      </ul>
    </div>
  );
}

function WeakWord({ word }: { word: PronunciationWord }) {
  const hint = ERROR_HINT[word.error_type];
  const badPhonemes = word.phonemes
    .filter((p) => p.accuracy != null && p.accuracy < 70)
    .sort((a, b) => (a.accuracy ?? 0) - (b.accuracy ?? 0))
    .slice(0, 4);

  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
      <span className="font-medium text-foreground">{word.word}</span>
      {word.accuracy != null && (
        <span className="tabular-nums text-muted-foreground">{Math.round(word.accuracy)}</span>
      )}
      {hint && <span className="text-amber-600 dark:text-amber-400">{hint}</span>}
      {badPhonemes.length > 0 && (
        <span className="flex flex-wrap items-baseline gap-1 text-muted-foreground">
          弱音：
          {badPhonemes.map((p, i) => (
            <span
              key={`${p.phoneme}-${i}`}
              className="rounded bg-destructive/15 px-1 font-mono text-destructive"
            >
              /{p.phoneme}/{p.accuracy != null && ` ${Math.round(p.accuracy)}`}
            </span>
          ))}
        </span>
      )}
    </li>
  );
}

function WordSpan({ word }: { word: PronunciationWord }) {
  const isOmission = word.error_type === 'Omission';
  const isMispron = word.error_type === 'Mispronunciation';
  const isInsertion = word.error_type === 'Insertion';
  const low = word.accuracy != null && word.accuracy < 60;

  const title =
    word.accuracy != null ? `${word.error_type} · ${Math.round(word.accuracy)}` : word.error_type;

  return (
    <>
      <span
        title={title}
        className={cn(
          'mr-1 inline-block',
          isOmission && 'text-muted-foreground line-through decoration-dashed',
          isInsertion && 'text-amber-600 underline decoration-wavy dark:text-amber-400',
          (isMispron || low) &&
            !isOmission &&
            !isInsertion &&
            'rounded bg-destructive/15 px-0.5 text-destructive',
        )}
      >
        {word.word}
      </span>{' '}
    </>
  );
}

function Score({
  label,
  value,
  primary = false,
}: {
  label: string;
  value: number | null;
  primary?: boolean;
}) {
  const color =
    value == null
      ? 'text-muted-foreground'
      : value >= 80
        ? 'text-emerald-600 dark:text-emerald-400'
        : value >= 60
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-destructive';
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('font-semibold tabular-nums', primary ? 'text-lg' : 'text-base', color)}>
        {value == null ? '—' : Math.round(value)}
      </span>
    </span>
  );
}
