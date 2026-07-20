import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Check, RotateCcw, X } from 'lucide-react';
import { getReviewQueue, gradeReview } from '../api';
import type {
  MaterialLanguage,
  ReviewArticleCard,
  ReviewQueue,
  ReviewScope,
  ReviewVocabCard,
} from '../types';
import SpeakButton from '../components/SpeakButton';
import { cn } from '@/lib/utils';

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/// Blank out the word inside its own example sentence, so the context can be
/// read as a prompt without giving the answer away.
function maskWord(
  context: string,
  word: string,
  language: MaterialLanguage,
): ReactNode[] {
  if (!word) return [context];
  const pattern = word.replace(ESCAPE, '\\$&');
  const re =
    language === 'ja'
      ? new RegExp(pattern, 'g')
      : new RegExp(`\\b${pattern}\\b`, 'gi');
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(context)) !== null) {
    if (m.index > last) parts.push(context.slice(last, m.index));
    parts.push(
      <span
        key={m.index}
        className="bg-foreground/15 text-transparent rounded px-1 select-none"
      >
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < context.length) parts.push(context.slice(last));
  return parts.length > 0 ? parts : [context];
}

const SCOPES: { key: ReviewScope; label: string }[] = [
  { key: 'bbc', label: 'BBC' },
  { key: 'mine', label: '我的材料' },
];

function intervalText(days: number): string {
  return days >= 30 ? `${Math.round(days / 30)} 个月后再见` : `${days} 天后再见`;
}

/// Today's spaced-repetition queue, split by shelf.
///
/// The server decides *what* is due and how far each item moves along the
/// Ebbinghaus ladder; this page only presents it and reports whether the user
/// recalled it. Items graded here disappear from the session immediately —
/// forgotten ones come back tomorrow, not later in the same sitting, because
/// re-showing an answer the user has just seen measures nothing.
export default function Review() {
  const [queue, setQueue] = useState<ReviewQueue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<ReviewScope>('mine');
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    getReviewQueue(scope)
      .then((q) => {
        setQueue(q);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [scope]);

  useEffect(load, [load]);

  const vocab = useMemo(
    () =>
      (queue?.vocab ?? []).filter((v) => !done.has(v.schedule_id)),
    [queue, done],
  );
  const articles = useMemo(
    () =>
      (queue?.articles ?? []).filter((a) => !done.has(a.schedule_id)),
    [queue, done],
  );

  const current = vocab[0] ?? null;

  async function judge(scheduleId: number, ok: boolean) {
    // Mark done first: the card should leave the screen on click, not after
    // the round-trip, or a slow response reads as an unresponsive button.
    setDone((prev) => new Set(prev).add(scheduleId));
    setRevealed(false);
    try {
      const res = await gradeReview(scheduleId, ok);
      setFlash(ok ? intervalText(res.interval_days) : '明天再来一次');
      window.setTimeout(() => setFlash(null), 1600);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const counts = queue?.counts;
  const scopeDue = (s: ReviewScope) =>
    s === 'bbc'
      ? (counts?.bbc_vocab ?? 0) + (counts?.bbc_articles ?? 0)
      : (counts?.mine_vocab ?? 0) + (counts?.mine_articles ?? 0);

  if (loading && !queue) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-6 py-12 text-sm text-muted-foreground">
          加载今日复习…
        </div>
      </main>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* Shelf picker and the day's articles: the standing context for the
          session, kept out of the way so the middle stays one card at a time. */}
      <aside className="flex w-80 shrink-0 flex-col border-r border-border bg-card">
        <div className="border-b border-border p-3">
          <div className="flex items-center gap-2">
            {SCOPES.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => {
                  setScope(s.key);
                  setRevealed(false);
                }}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition',
                  scope === s.key
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-accent',
                )}
              >
                {s.label}
                <span className="ml-1.5 text-xs tabular-nums opacity-70">
                  {scopeDue(s.key)}
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setDone(new Set());
                load();
              }}
              title="刷新"
              className="ml-auto inline-flex size-8 items-center justify-center rounded-md border border-border bg-background text-foreground transition hover:bg-accent"
            >
              <RotateCcw className="size-3.5" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <h2 className="mb-2 text-xs font-medium text-muted-foreground">
            回顾文章
          </h2>
          {articles.length > 0 ? (
            <div className="space-y-2">
              {articles.map((a) => (
                <ArticleRow key={a.schedule_id} article={a} onJudge={judge} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">今天没有要回顾的文章。</p>
          )}
        </div>

        {counts && (
          <div className="border-t border-border px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
            今日 {counts.serving_vocab + counts.serving_articles} 项 · 待复习{' '}
            {counts.due_vocab + counts.due_articles} · 已排程{' '}
            {counts.scheduled_total}
            <br />
            艾宾浩斯:1、2、4、7、15、30、60 天
          </div>
        )}
      </aside>

      {/* One card, centred — the only thing the user should be looking at. */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-xl px-6 py-10">
          {error && (
            <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="mb-3 flex items-baseline justify-between">
            <h1 className="text-lg font-medium text-foreground">生词与短语</h1>
            <span className="text-xs tabular-nums text-muted-foreground">
              剩 {vocab.length}
            </span>
          </div>

          {current ? (
            <VocabFlashcard
              card={current}
              revealed={revealed}
              onReveal={() => setRevealed(true)}
              onJudge={judge}
            />
          ) : (
            <div className="rounded-lg border border-border bg-card p-8 text-center">
              <p className="text-sm text-foreground">
                {articles.length > 0
                  ? '生词都过完了,左边还有文章要回顾。'
                  : '这一侧今天没有待复习的内容了。'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                新的内容会在到期那天自动出现。
              </p>
            </div>
          )}

          {flash && (
            <div className="pointer-events-none fixed bottom-8 left-1/2 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-xs text-background shadow-lg">
              {flash}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function ArticleRow({
  article,
  onJudge,
}: {
  article: ReviewArticleCard;
  onJudge: (scheduleId: number, ok: boolean) => void;
}) {
  // Stacked rather than one row: the sidebar is 320px wide, where a title plus
  // two buttons side by side would crush the title to a few characters.
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2.5">
      <div className="flex items-start gap-2">
        <BookOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <Link
          to={`/m/${article.id}`}
          className="min-w-0 flex-1 text-sm leading-snug text-foreground hover:underline"
        >
          {article.title}
        </Link>
      </div>
      <div className="mt-1 pl-5 text-[11px] text-muted-foreground">
        {article.vocab_count} 个生词 · 第 {article.reviews + 1} 次复习
      </div>
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={() => onJudge(article.schedule_id, false)}
          className="flex-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-accent"
        >
          还得再看
        </button>
        <button
          type="button"
          onClick={() => onJudge(article.schedule_id, true)}
          className="flex-1 rounded-md bg-primary px-2 py-1 text-[11px] text-primary-foreground transition hover:bg-primary/90"
        >
          记得了
        </button>
      </div>
    </div>
  );
}

function VocabFlashcard({
  card,
  revealed,
  onReveal,
  onJudge,
}: {
  card: ReviewVocabCard;
  revealed: boolean;
  onReveal: () => void;
  onJudge: (scheduleId: number, ok: boolean) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded border border-border px-1.5 py-0.5">
          {card.kind === 'idiom' ? '短语' : '单词'}
        </span>
        {card.material_title && (
          <span className="truncate">来自《{card.material_title}》</span>
        )}
        <span className="ml-auto shrink-0 tabular-nums">
          第 {card.reviews + 1} 次
        </span>
      </div>

      <div className="mb-4 flex items-center gap-2">
        <span className="text-2xl font-medium text-foreground">{card.word}</span>
        <SpeakButton word={card.word} materialId={card.material_id ?? undefined} />
        {card.phonetic && (
          <span className="text-sm text-muted-foreground">{card.phonetic}</span>
        )}
      </div>

      {card.context && (
        <p className="mb-5 rounded-md bg-muted/50 px-3 py-2 text-sm leading-relaxed text-foreground">
          {revealed ? card.context : maskWord(card.context, card.word, 'en')}
        </p>
      )}

      {revealed ? (
        <>
          <div className="mb-5 space-y-1">
            <p className="text-sm text-foreground">{card.definition_zh}</p>
            {card.definition_en && (
              <p className="text-sm text-muted-foreground">
                {card.definition_en}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onJudge(card.schedule_id, false)}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm text-foreground transition hover:bg-accent"
            >
              <X className="size-4" />
              没想起来
            </button>
            <button
              type="button"
              onClick={() => onJudge(card.schedule_id, true)}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground transition hover:bg-primary/90"
            >
              <Check className="size-4" />
              记得
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={onReveal}
          className="w-full rounded-md border border-border px-3 py-2 text-sm text-foreground transition hover:bg-accent"
        >
          显示释义
        </button>
      )}
    </div>
  );
}
