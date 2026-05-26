import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, BookOpen, Library, Trash2, ArrowLeft } from 'lucide-react';
import {
  createClozeExercise,
  deleteClozeExercise,
  getClozeExercise,
  gradeClozeExercise,
  listClozeCandidates,
  listClozeExercises,
} from '../api';
import type {
  ClozeBlankResult,
  ClozeBlankStatus,
  ClozeCategory,
  ClozeDifficulty,
  ClozeExercise,
  ClozeExerciseSummary,
  ClozeGradeResult,
  NewsItemSummary,
  NewsSource,
  NewsTopic,
} from '../types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type View =
  | { kind: 'pick' }
  | { kind: 'mine' }
  | { kind: 'practice'; exerciseId: number };

const TOPICS: { value: NewsTopic; label: string }[] = [
  { value: 'finance', label: '财经' },
  { value: 'politics', label: '政治' },
  { value: 'tech', label: '科技' },
  { value: 'culture', label: '文化' },
  { value: 'other', label: '其他' },
];
const SOURCES: { value: NewsSource; label: string }[] = [
  { value: 'bbc' as NewsSource, label: 'BBC' },
  { value: 'bloomberg' as NewsSource, label: 'Bloomberg' },
  { value: 'economist' as NewsSource, label: 'Economist' },
  { value: 'ft' as NewsSource, label: 'FT' },
];

export default function Cloze() {
  const [view, setView] = useState<View>({ kind: 'pick' });

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-6 py-10">
        {view.kind !== 'practice' && (
          <div className="mb-6 flex items-baseline justify-between">
            <div>
              <h1 className="text-2xl font-medium tracking-tight text-foreground">
                填空练习
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                从高质量英文新闻里挑一条,AI 帮你简化成短文并挖出关键词,边读边填。
              </p>
            </div>
            <div className="flex gap-1 rounded-md border border-border bg-card p-1">
              <TabButton
                active={view.kind === 'pick'}
                onClick={() => setView({ kind: 'pick' })}
                icon={<BookOpen className="size-4" />}
                label="挑新闻"
              />
              <TabButton
                active={view.kind === 'mine'}
                onClick={() => setView({ kind: 'mine' })}
                icon={<Library className="size-4" />}
                label="我的练习"
              />
            </div>
          </div>
        )}

        {view.kind === 'pick' && (
          <CandidateList
            onStart={(exId) => setView({ kind: 'practice', exerciseId: exId })}
          />
        )}
        {view.kind === 'mine' && (
          <MyExercises
            onOpen={(id) => setView({ kind: 'practice', exerciseId: id })}
          />
        )}
        {view.kind === 'practice' && (
          <PracticeView
            exerciseId={view.exerciseId}
            onBack={() => setView({ kind: 'mine' })}
          />
        )}
      </div>
    </main>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm transition',
        active
          ? 'bg-accent text-foreground font-medium'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ===================== Candidate news picker =====================

function CandidateList({ onStart }: { onStart: (id: number) => void }) {
  const [items, setItems] = useState<NewsItemSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [topic, setTopic] = useState<NewsTopic | 'all'>('all');
  const [source, setSource] = useState<NewsSource | 'all'>('all');
  const [picking, setPicking] = useState<NewsItemSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listClozeCandidates({
      topic: topic === 'all' ? undefined : topic,
      source: source === 'all' ? undefined : source,
    })
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [topic, source]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-3">
        <select
          value={topic}
          onChange={(e) => setTopic(e.target.value as NewsTopic | 'all')}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm"
        >
          <option value="all">全部主题</option>
          {TOPICS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as NewsSource | 'all')}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm"
        >
          <option value="all">全部来源</option>
          {SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {loading && <p className="text-sm text-muted-foreground">加载中...</p>}
      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
          没有符合条件的高质量新闻 — 换个 filter 试试,或者等爬取任务再跑一轮。
        </div>
      )}

      <ul className="grid gap-3 md:grid-cols-2">
        {items.map((n) => (
          <li
            key={n.id}
            className="rounded-lg border border-border bg-card p-3 transition hover:border-foreground/20"
          >
            <div className="flex gap-3">
              {n.thumbnail_url && (
                <img
                  src={n.thumbnail_url}
                  alt=""
                  className="h-20 w-32 shrink-0 rounded object-cover"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm font-medium leading-5 text-foreground">
                  {n.title}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="rounded bg-accent px-1.5 py-0.5 text-foreground/70">
                    {n.source.toUpperCase()}
                  </span>
                  <span className="rounded bg-accent px-1.5 py-0.5 text-foreground/70">
                    {topicLabel(n.topic)}
                  </span>
                  <span>{formatDuration(n.duration_sec)}</span>
                  {n.quality != null && <span>· quality {n.quality}/10</span>}
                </div>
                <div className="mt-2 flex justify-end">
                  <Button size="sm" onClick={() => setPicking(n)}>
                    生成练习
                  </Button>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {picking && (
        <DifficultyDialog
          news={picking}
          onCancel={() => setPicking(null)}
          onStart={(id) => {
            setPicking(null);
            onStart(id);
          }}
        />
      )}
    </div>
  );
}

function DifficultyDialog({
  news,
  onCancel,
  onStart,
}: {
  news: NewsItemSummary;
  onCancel: () => void;
  onStart: (exerciseId: number) => void;
}) {
  const [difficulty, setDifficulty] = useState<ClozeDifficulty>('normal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const ex = await createClozeExercise({ news_id: news.id, difficulty });
      onStart(ex.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-base font-medium text-foreground">
          生成填空练习
        </h3>
        <p className="mb-4 line-clamp-2 text-xs text-muted-foreground">
          {news.title}
        </p>
        <div className="mb-4 flex flex-col gap-2">
          {(['easy', 'normal', 'hard'] as ClozeDifficulty[]).map((d) => (
            <label
              key={d}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm transition',
                difficulty === d
                  ? 'border-foreground/40 bg-accent/50'
                  : 'border-border bg-card hover:border-foreground/20',
              )}
            >
              <input
                type="radio"
                name="difficulty"
                checked={difficulty === d}
                onChange={() => setDifficulty(d)}
                className="mt-0.5 accent-primary"
              />
              <div>
                <div className="font-medium text-foreground">
                  {difficultyLabel(d)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {difficultyHint(d)}
                </div>
              </div>
            </label>
          ))}
        </div>
        {error && (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button size="sm" onClick={go} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? '生成中...' : '开始'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ===================== My exercises =====================

function MyExercises({ onOpen }: { onOpen: (id: number) => void }) {
  const [items, setItems] = useState<ClozeExerciseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listClozeExercises()
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onDelete(id: number) {
    if (!confirm('删除这份练习?')) return;
    await deleteClozeExercise(id);
    setItems((prev) => prev.filter((x) => x.id !== id));
  }

  if (loading) return <p className="text-sm text-muted-foreground">加载中...</p>;
  if (error)
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {error}
      </div>
    );
  if (items.length === 0)
    return (
      <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
        还没生成过练习。去"挑新闻"开始第一份。
      </div>
    );

  return (
    <ul className="space-y-2">
      {items.map((x) => (
        <li
          key={x.id}
          className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
        >
          <button
            type="button"
            onClick={() => onOpen(x.id)}
            className="min-w-0 flex-1 text-left"
          >
            <p className="line-clamp-1 text-sm font-medium text-foreground">
              {x.source_title}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="rounded bg-accent px-1.5 py-0.5 text-foreground/70">
                {topicLabel(x.source_topic)}
              </span>
              <span className="rounded bg-accent px-1.5 py-0.5 text-foreground/70">
                {difficultyLabel(x.difficulty)}
              </span>
              <span>{x.blank_count} 空</span>
              {x.last_attempt && (
                <span>· 上次 {Math.round(x.last_attempt.score * 100)}%</span>
              )}
              <span>· {new Date(x.created_at).toLocaleString()}</span>
            </div>
          </button>
          <button
            type="button"
            onClick={() => onDelete(x.id)}
            className="text-muted-foreground hover:text-destructive"
            aria-label="删除"
          >
            <Trash2 className="size-4" />
          </button>
        </li>
      ))}
    </ul>
  );
}

// ===================== Practice view =====================

function PracticeView({
  exerciseId,
  onBack,
}: {
  exerciseId: number;
  onBack: () => void;
}) {
  const [exercise, setExercise] = useState<ClozeExercise | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [grade, setGrade] = useState<ClozeGradeResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [revealed, setRevealed] = useState(false);
  // Skeleton hints (first letter + underscores per word) anchor each blank
  // to one answer. Toggle off for a true hard-mode where only the category
  // is visible. Persists across exercises via localStorage.
  const [skeletonOn, setSkeletonOn] = useState<boolean>(() => {
    const v = localStorage.getItem('cloze-skeleton-on');
    return v == null ? true : v === '1';
  });
  useEffect(() => {
    localStorage.setItem('cloze-skeleton-on', skeletonOn ? '1' : '0');
  }, [skeletonOn]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getClozeExercise(exerciseId)
      .then((ex) => {
        if (cancelled) return;
        setExercise(ex);
        // Seed inputs with last attempt's answers if any, so the user can pick
        // up where they left off when redoing an exercise.
        const initial = ex.last_attempt?.answers?.length
          ? [...ex.last_attempt.answers]
          : new Array(ex.blanks.length).fill('');
        while (initial.length < ex.blanks.length) initial.push('');
        setAnswers(initial.slice(0, ex.blanks.length));
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [exerciseId]);

  async function onSubmit() {
    if (!exercise || submitting) return;
    setSubmitting(true);
    try {
      const g = await gradeClozeExercise(exercise.id, answers);
      setGrade(g);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function onReset() {
    if (!exercise) return;
    setAnswers(new Array(exercise.blanks.length).fill(''));
    setGrade(null);
    setRevealed(false);
  }

  if (loading) return <p className="text-sm text-muted-foreground">加载中...</p>;
  if (error || !exercise)
    return (
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" /> 返回
        </Button>
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error ?? '未找到练习'}
        </div>
      </div>
    );

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" /> 返回
        </Button>
        <div className="flex items-center gap-2">
          {grade && (
            <span className="text-sm text-foreground">
              得分:{' '}
              <span className="font-medium">
                {grade.correct_count} / {grade.total_count}
              </span>{' '}
              ({Math.round(grade.score * 100)}%)
            </span>
          )}
          <label className="inline-flex cursor-pointer items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={skeletonOn}
              onChange={(e) => setSkeletonOn(e.target.checked)}
              className="accent-primary"
              disabled={!!grade}
            />
            首字母提示
          </label>
          <Button variant="ghost" size="sm" onClick={onReset}>
            重置
          </Button>
          {!grade && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRevealed((v) => !v)}
            >
              {revealed ? '隐藏答案' : '看答案'}
            </Button>
          )}
          <Button onClick={onSubmit} disabled={submitting || !!grade}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {grade ? '已提交' : submitting ? '评分中...' : '提交评分'}
          </Button>
        </div>
      </div>

      <div className="mb-1">
        <h2 className="text-base font-medium text-foreground">
          {exercise.source_title}
        </h2>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="rounded bg-accent px-1.5 py-0.5 text-foreground/70">
            {topicLabel(exercise.source_topic)}
          </span>
          <span className="rounded bg-accent px-1.5 py-0.5 text-foreground/70">
            {difficultyLabel(exercise.difficulty)}
          </span>
          <span>{exercise.blanks.length} 个空</span>
        </div>
      </div>

      <article className="mt-4 rounded-lg border border-border bg-card p-5 text-[15px] leading-9 text-foreground">
        <ClozeText
          text={exercise.simplified_text}
          blanks={exercise.blanks}
          answers={answers}
          setAnswers={setAnswers}
          grade={grade}
          revealed={revealed}
          skeletonOn={skeletonOn}
          disabled={!!grade || submitting}
        />
      </article>

      {grade && <GradeReport grade={grade} blanks={exercise.blanks} />}
    </div>
  );
}

const PLACEHOLDER_RE = /\{\{(\d+)\}\}/g;

function ClozeText({
  text,
  blanks,
  answers,
  setAnswers,
  grade,
  revealed,
  skeletonOn,
  disabled,
}: {
  text: string;
  blanks: ClozeExercise['blanks'];
  answers: string[];
  setAnswers: (next: string[]) => void;
  grade: ClozeGradeResult | null;
  revealed: boolean;
  skeletonOn: boolean;
  disabled: boolean;
}) {
  // Split text into [text, blankIdx, text, blankIdx, ...] segments.
  const parts = useMemo(() => splitWithPlaceholders(text), [text]);

  // refs to focus next input on Tab/Enter — small UX touch
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  function update(i: number, v: string) {
    const next = [...answers];
    next[i] = v;
    setAnswers(next);
  }

  function focusNext(i: number) {
    const next = refs.current[i + 1];
    if (next) next.focus();
  }

  return (
    <p className="whitespace-pre-wrap">
      {parts.map((part, idx) => {
        if (typeof part === 'string') return <span key={idx}>{part}</span>;
        const blankIdx = part;
        const blank = blanks[blankIdx];
        if (!blank) return null;
        const value = answers[blankIdx] ?? '';
        const result = grade?.results.find((r) => r.index === blankIdx) ?? null;
        return (
          <BlankInput
            key={idx}
            ref={(el) => {
              refs.current[blankIdx] = el;
            }}
            value={value}
            answer={blank.answer}
            category={blank.category}
            hint={blank.hint}
            skeletonOn={skeletonOn}
            revealed={revealed}
            result={result}
            disabled={disabled}
            onChange={(v) => update(blankIdx, v)}
            onEnter={() => focusNext(blankIdx)}
          />
        );
      })}
    </p>
  );
}

interface BlankInputProps {
  value: string;
  answer: string;
  category: ClozeCategory;
  hint?: string;
  /** When on, placeholder shows a "t____ d___" skeleton anchored to the
   *  answer (and the LLM hint is rendered below). When off, only the
   *  category label is visible — the input is a true blank slate. */
  skeletonOn: boolean;
  revealed: boolean;
  result: ClozeBlankResult | null;
  disabled: boolean;
  onChange: (v: string) => void;
  onEnter: () => void;
}

const BlankInput = forwardRef<HTMLInputElement, BlankInputProps>(function BlankInput(
  {
    value,
    answer,
    category,
    hint,
    skeletonOn,
    revealed,
    result,
    disabled,
    onChange,
    onEnter,
  },
  ref,
) {
  const status: ClozeBlankStatus | 'idle' = result?.status ?? 'idle';
  const showAnswer = revealed && !result;
  // Width matches the answer length so the user can also count letters.
  // The skeleton (if on) further pins the answer down character-by-character.
  const widthCh = Math.max(6, Math.min(answer.length + 2, 22));
  const placeholder = skeletonOn ? buildSkeleton(answer) : categoryLabel(category);
  const showHintLine = skeletonOn && hint && !result;
  return (
    <span className="inline-flex flex-col items-stretch align-baseline">
      <input
        ref={ref}
        type="text"
        value={showAnswer ? answer : value}
        placeholder={placeholder}
        disabled={disabled || showAnswer}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onEnter();
          }
        }}
        style={{ width: `${widthCh}ch` }}
        className={cn(
          'mx-1 inline-block rounded border-b-2 bg-transparent px-1.5 py-0.5 text-center text-sm font-medium outline-none transition',
          // The placeholder needs its own color so it stands out from a typed
          // answer; native CSS already dims it but we add a touch.
          'placeholder:font-normal placeholder:tracking-wider placeholder:text-muted-foreground/70',
          status === 'idle' &&
            !showAnswer &&
            'border-foreground/40 focus:border-primary',
          showAnswer && 'border-amber-500 text-amber-700',
          status === 'correct' &&
            'border-emerald-500 bg-emerald-50 text-emerald-700',
          status === 'close' && 'border-amber-500 bg-amber-50 text-amber-800',
          status === 'wrong' &&
            'border-destructive bg-destructive/10 text-destructive',
          status === 'empty' && 'border-destructive/60 text-muted-foreground',
        )}
      />
      {showHintLine && (
        <span className="mt-0.5 flex items-center justify-center gap-1 text-[10px] leading-3 text-muted-foreground">
          <span className="rounded bg-accent/60 px-1 py-px text-[9px] text-foreground/60">
            {categoryLabel(category)}
          </span>
          <span className="truncate">{hint}</span>
        </span>
      )}
      {result && result.status !== 'correct' && (
        <span className="mt-0.5 text-center text-[10px] font-normal leading-3 text-muted-foreground">
          ✓ {result.correct_answer}
        </span>
      )}
    </span>
  );
});

function GradeReport({
  grade,
  blanks,
}: {
  grade: ClozeGradeResult;
  blanks: ClozeExercise['blanks'];
}) {
  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-medium text-foreground">详细讲解</h3>
      <ul className="space-y-2.5">
        {grade.results.map((r) => {
          const cat = blanks[r.index]?.category;
          return (
            <li
              key={r.index}
              className="flex items-start gap-3 rounded-md bg-accent/30 p-2.5 text-sm"
            >
              <span
                className={cn(
                  'mt-0.5 inline-block w-6 shrink-0 rounded text-center text-[11px] font-medium',
                  r.status === 'correct' && 'bg-emerald-100 text-emerald-700',
                  r.status === 'close' && 'bg-amber-100 text-amber-800',
                  r.status === 'wrong' && 'bg-destructive/15 text-destructive',
                  r.status === 'empty' && 'bg-muted text-muted-foreground',
                )}
              >
                #{r.index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-1.5">
                  {cat && (
                    <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-foreground/70">
                      {categoryLabel(cat)}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">你的:</span>
                  <span
                    className={cn(
                      r.status === 'correct' && 'text-emerald-700',
                      r.status === 'wrong' && 'text-destructive line-through',
                      r.status === 'empty' && 'text-muted-foreground italic',
                    )}
                  >
                    {r.user_answer || '(空)'}
                  </span>
                  {r.status !== 'correct' && (
                    <>
                      <span className="text-xs text-muted-foreground">正确:</span>
                      <span className="font-medium text-foreground">
                        {r.correct_answer}
                      </span>
                    </>
                  )}
                </div>
                <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {r.explanation_zh}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ----- helpers -----

function splitWithPlaceholders(text: string): Array<string | number> {
  const out: Array<string | number> = [];
  let last = 0;
  // reset the regex's lastIndex since it's global
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(Number(m[1]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function topicLabel(t: NewsTopic): string {
  const found = TOPICS.find((x) => x.value === t);
  return found ? found.label : t;
}

function difficultyLabel(d: ClozeDifficulty): string {
  switch (d) {
    case 'easy':
      return '简单';
    case 'hard':
      return '进阶';
    default:
      return '普通';
  }
}

function difficultyHint(d: ClozeDifficulty): string {
  switch (d) {
    case 'easy':
      return '高频实义词,8-10 个空';
    case 'hard':
      return '短语动词/习语/搭配,12-15 个空';
    default:
      return '平衡选词,10-12 个空';
  }
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** First letter of each word + underscores for the remaining letters.
 *  Non-letter chars (apostrophes, hyphens) are kept as-is.
 *
 *  Examples:
 *    "turned"      → "t_____"
 *    "turned down" → "t_____ d___"
 *    "haven't"     → "h___'_"
 *    "in"          → "i_"
 */
function buildSkeleton(answer: string): string {
  return answer
    .split(/(\s+)/) // keep whitespace as separator tokens
    .map((tok) => {
      if (/^\s+$/.test(tok)) return tok;
      let out = '';
      let seenFirstLetter = false;
      for (const ch of tok) {
        if (/[A-Za-z]/.test(ch)) {
          if (!seenFirstLetter) {
            out += ch.toLowerCase();
            seenFirstLetter = true;
          } else {
            out += '_';
          }
        } else {
          out += ch;
        }
      }
      return out;
    })
    .join('');
}

const CATEGORY_LABELS: Record<ClozeCategory, string> = {
  word: '词',
  phrase: '短语动词',
  idiom: '习语',
  collocation: '搭配',
  preposition: '介词',
  article: '冠词',
  connective: '连词',
  verb_form: '动词形式',
  modal: '情态',
};

function categoryLabel(c: ClozeCategory): string {
  return CATEGORY_LABELS[c] ?? '其他';
}
