import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  deleteInterviewQuestion,
  generateInterviewQuestions,
  listInterviewQuestions,
  listInterviewTopics,
} from '../api';
import type {
  InterviewCategory,
  InterviewQuestion,
  InterviewTopic,
  InterviewTrack,
} from '../types';
import SpeakButton from '../components/SpeakButton';
import { AnswerMarkdown } from '../lib/answer-markdown';
import { stripMarkdownForTts } from '../lib/strip-markdown';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const LAST_TOPIC_KEY = 'interview:last-topic-id';
const COLLAPSED_TRACKS_KEY = 'interview:collapsed-tracks';

const TRACK_LABEL: Record<InterviewTrack, string> = {
  rust: 'Rust',
  ddia: '分布式系统 (DDIA)',
  ai_agent: 'AI Agent',
  workplace: '日常职场英语',
};

const TRACK_ORDER: InterviewTrack[] = [
  'rust',
  'ddia',
  'ai_agent',
  'workplace',
];

const CATEGORY_LABEL: Record<InterviewCategory, string> = {
  rust_basic: 'Ch 1-10 基础',
  rust_advanced: 'Ch 11-20 进阶',
  ddia_foundations: 'Part I 数据系统基础',
  ddia_distributed: 'Part II 分布式数据',
  ddia_derived: 'Part III 派生数据',
  ddia_practical: '系统设计高频题',
  ai_agent: 'AI Agent',
  workplace_intro: '自我介绍 / 社交',
  workplace_comm: '沟通与协作',
  workplace_feedback: '反馈与 1:1',
  workplace_hard: '难场景 / 跨文化',
};

const CATEGORY_ORDER: InterviewCategory[] = [
  'rust_basic',
  'rust_advanced',
  'ddia_foundations',
  'ddia_distributed',
  'ddia_derived',
  'ddia_practical',
  'ai_agent',
  'workplace_intro',
  'workplace_comm',
  'workplace_feedback',
  'workplace_hard',
];

export default function Interview() {
  const [topics, setTopics] = useState<InterviewTopic[]>([]);
  const [topicsLoading, setTopicsLoading] = useState(true);
  const [topicsError, setTopicsError] = useState<string | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    listInterviewTopics()
      .then((rows) => {
        if (cancelled) return;
        setTopics(rows);
        const saved = Number(localStorage.getItem(LAST_TOPIC_KEY));
        const initial =
          rows.find((t) => t.id === saved)?.id ?? rows[0]?.id ?? null;
        setSelectedTopicId(initial);
      })
      .catch((e: Error) => !cancelled && setTopicsError(e.message))
      .finally(() => !cancelled && setTopicsLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  function onSelectTopic(id: number) {
    setSelectedTopicId(id);
    localStorage.setItem(LAST_TOPIC_KEY, String(id));
  }

  // Group topics two levels deep: track → category → topics. Both levels
  // come from constant orderings so an empty track or category just skips.
  const groupedByTrack = useMemo(() => {
    const byTrack = new Map<
      InterviewTrack,
      Map<InterviewCategory, InterviewTopic[]>
    >();
    for (const track of TRACK_ORDER) {
      const inner = new Map<InterviewCategory, InterviewTopic[]>();
      for (const cat of CATEGORY_ORDER) inner.set(cat, []);
      byTrack.set(track, inner);
    }
    for (const t of topics) {
      const inner = byTrack.get(t.track);
      if (!inner) continue;
      const list = inner.get(t.category);
      if (list) list.push(t);
    }
    return byTrack;
  }, [topics]);

  const selectedTopic = useMemo(
    () => topics.find((t) => t.id === selectedTopicId) ?? null,
    [topics, selectedTopicId],
  );

  // Per-track collapse state, persisted across sessions. Empty default →
  // every track expanded on first visit.
  const [collapsedTracks, setCollapsedTracks] = useState<Set<InterviewTrack>>(
    () => {
      try {
        const raw = localStorage.getItem(COLLAPSED_TRACKS_KEY);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw) as string[];
        return new Set(parsed as InterviewTrack[]);
      } catch {
        return new Set();
      }
    },
  );

  function toggleTrack(track: InterviewTrack) {
    setCollapsedTracks((cur) => {
      const next = new Set(cur);
      if (next.has(track)) next.delete(track);
      else next.add(track);
      localStorage.setItem(
        COLLAPSED_TRACKS_KEY,
        JSON.stringify(Array.from(next)),
      );
      return next;
    });
  }

  return (
    <main className="flex-1 overflow-hidden">
      <div className="mx-auto flex h-full w-full max-w-7xl">
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-border bg-card/40 px-3 py-6">
          <div className="mb-4 px-2">
            <h1 className="text-xl font-medium tracking-tight text-foreground">
              面试备战
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              英文技术面试问答练习
            </p>
          </div>

          {topicsLoading && (
            <div className="flex items-center gap-2 px-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              加载章节
            </div>
          )}
          {topicsError && (
            <div className="px-2 text-sm text-destructive">{topicsError}</div>
          )}

          {TRACK_ORDER.map((track) => {
            const inner = groupedByTrack.get(track);
            if (!inner) return null;
            const trackTotal = Array.from(inner.values()).reduce(
              (n, list) => n + list.length,
              0,
            );
            if (trackTotal === 0) return null;
            const collapsed = collapsedTracks.has(track);
            return (
              <div key={track} className="mb-4">
                <button
                  type="button"
                  onClick={() => toggleTrack(track)}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm font-semibold uppercase tracking-wider text-foreground/80 hover:bg-accent/60"
                >
                  {collapsed ? (
                    <ChevronRight className="size-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="size-3.5 text-muted-foreground" />
                  )}
                  <span className="flex-1 truncate">{TRACK_LABEL[track]}</span>
                  <span className="text-[10px] font-normal text-muted-foreground">
                    {trackTotal}
                  </span>
                </button>

                {!collapsed && (
                  <div className="mt-1.5 space-y-3 pl-2">
                    {CATEGORY_ORDER.map((cat) => {
                      const items = inner.get(cat) ?? [];
                      if (items.length === 0) return null;
                      return (
                        <div key={cat}>
                          <div className="mb-1 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground/80">
                            {CATEGORY_LABEL[cat]}
                          </div>
                          <ul className="space-y-0.5">
                            {items.map((t) => (
                              <li key={t.id}>
                                <button
                                  type="button"
                                  onClick={() => onSelectTopic(t.id)}
                                  className={cn(
                                    'w-full rounded-md px-2 py-1.5 text-left text-base transition',
                                    selectedTopicId === t.id
                                      ? 'bg-accent text-foreground font-medium'
                                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                                  )}
                                >
                                  <div className="flex items-baseline gap-1.5">
                                    {t.chapter_no != null && (
                                      <span className="text-xs text-muted-foreground/70">
                                        Ch {t.chapter_no}
                                      </span>
                                    )}
                                    <span className="truncate">
                                      {t.title_zh}
                                    </span>
                                  </div>
                                  <div className="truncate text-xs text-muted-foreground/80">
                                    {t.title_en}
                                  </div>
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </aside>

        <section className="flex-1 overflow-y-auto">
          {selectedTopic ? (
            <TopicView key={selectedTopic.id} topic={selectedTopic} />
          ) : (
            !topicsLoading && (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                选择左侧一个章节开始
              </div>
            )
          )}
        </section>
      </div>
    </main>
  );
}

function sourceLabelForTrack(track: InterviewTrack): string {
  switch (track) {
    case 'rust':
      return 'Rust Book';
    case 'ddia':
      return 'DDIA';
    case 'ai_agent':
      return '原文';
    case 'workplace':
      return '参考';
  }
}

function TopicView({ topic }: { topic: InterviewTopic }) {
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    listInterviewQuestions(topic.id)
      .then((rows) => !cancelled && setQuestions(rows))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [topic.id]);

  async function onGenerate() {
    if (generating) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const res = await generateInterviewQuestions(topic.id, 5);
      setQuestions((cur) => [...cur, ...res.inserted]);
      setExpandedIds(
        (cur) => new Set([...cur, ...res.inserted.map((q) => q.id)]),
      );
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : '生成失败');
    } finally {
      setGenerating(false);
    }
  }

  async function onDelete(id: number) {
    if (!confirm('删除这道题？(只能删除自己生成的)')) return;
    try {
      await deleteInterviewQuestion(id);
      setQuestions((cur) => cur.filter((q) => q.id !== id));
    } catch (e) {
      alert(e instanceof Error ? e.message : '删除失败');
    }
  }

  function toggleExpand(id: number) {
    setExpandedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const systemCount = questions.filter((q) => q.is_system).length;
  const userCount = questions.length - systemCount;

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <div className="flex items-baseline gap-2">
          {topic.chapter_no != null && (
            <span className="text-sm font-medium text-muted-foreground">
              Chapter {topic.chapter_no}
            </span>
          )}
          <h2 className="text-2xl font-medium tracking-tight text-foreground">
            {topic.title_en}
          </h2>
        </div>
        <div className="mt-1 flex items-center gap-3 text-base text-muted-foreground">
          <span>{topic.title_zh}</span>
          {topic.source_url && (
            <a
              href={topic.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              {sourceLabelForTrack(topic.track)}{' '}
              <ExternalLink className="size-3" />
            </a>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onGenerate}
            disabled={generating}
          >
            {generating ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                生成中…
              </>
            ) : (
              <>
                <Sparkles className="size-3.5" />
                让 AI 再出 5 道
              </>
            )}
          </Button>
          <span className="text-sm text-muted-foreground">
            {loading
              ? '…'
              : `${systemCount} 道预置${userCount > 0 ? ` · ${userCount} 道你的` : ''}`}
          </span>
        </div>
        {generateError && (
          <div className="mt-2 text-sm text-destructive">{generateError}</div>
        )}
      </header>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          加载问答…
        </div>
      )}
      {error && <div className="text-sm text-destructive">{error}</div>}

      {!loading && !error && questions.length === 0 && (
        <div className="text-sm text-muted-foreground">暂无问答。</div>
      )}

      <ol className="space-y-3">
        {questions.map((q, i) => (
          <QuestionCard
            key={q.id}
            question={q}
            index={i + 1}
            expanded={expandedIds.has(q.id)}
            onToggle={() => toggleExpand(q.id)}
            onDelete={() => onDelete(q.id)}
          />
        ))}
      </ol>
    </div>
  );
}

function QuestionCard({
  question,
  index,
  expanded,
  onToggle,
  onDelete,
}: {
  question: InterviewQuestion;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-3 text-left"
      >
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-muted-foreground">
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span className="flex-1 text-base font-medium text-foreground">
              {question.question_en}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {expanded ? (
                <ChevronDown className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )}
            </span>
          </div>
          {question.question_zh && (
            <div className="mt-1 text-sm text-muted-foreground">
              {question.question_zh}
            </div>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 py-4 space-y-4">
          <section>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Sample answer (EN)
              </h3>
              <SpeakButton
                word={stripMarkdownForTts(question.sample_answer_en)}
                language="en"
              />
              {question.provider === 'fallback' && (
                <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  Gemini 兜底
                </span>
              )}
            </div>
            <AnswerMarkdown text={question.sample_answer_en} />
          </section>

          {question.sample_answer_zh && (
            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                中文要点
              </h3>
              <AnswerMarkdown
                text={question.sample_answer_zh}
                tone="muted"
              />
            </section>
          )}

          {question.key_points.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                必答 key points
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {question.key_points.map((kp, i) => (
                  <span
                    key={i}
                    className="rounded-full border border-border bg-background px-2 py-0.5 text-sm text-foreground"
                  >
                    {kp}
                  </span>
                ))}
              </div>
            </section>
          )}

          {question.follow_ups.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                可能的追问
              </h3>
              <ul className="space-y-1">
                {question.follow_ups.map((fu, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-base text-muted-foreground"
                  >
                    <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                    <span className="flex-1">{fu}</span>
                    <SpeakButton word={fu} language="en" />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!question.is_system && (
            <div className="pt-1">
              <button
                type="button"
                onClick={onDelete}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3" />
                删除
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
