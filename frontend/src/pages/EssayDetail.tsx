import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ExternalLink,
  Trash2,
  Highlighter,
  ListTree,
  PlayCircle,
  Play,
  Pause,
  Loader2,
} from 'lucide-react';
import { deleteEssay, getEssay, listVocab, translateEssay } from '../api';
import SelectionPopup from '../components/SelectionPopup';
import AddVocabDialog from '../components/AddVocabDialog';
import { languageAdapter } from '../lib/languages';
import { highlightText } from '../lib/highlight';
import type { VocabEntry } from '../types';
import type {
  EssayParagraphFunction,
  ModelEssay,
} from '../types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { SOURCE_LABEL, SOURCE_TONE, STYLE_LABEL } from './Essays';
import ProviderBadge from '../components/ProviderBadge';

const FUNCTION_LABEL: Record<EssayParagraphFunction, string> = {
  thesis: '论点',
  evidence: '论据',
  counter: '反驳',
  transition: '过渡',
  conclusion: '收尾',
  narrative: '叙事',
  analysis: '分析',
  other: '其他',
};

const FUNCTION_TONE: Record<EssayParagraphFunction, string> = {
  thesis: 'bg-violet-100 text-violet-800',
  evidence: 'bg-emerald-100 text-emerald-800',
  counter: 'bg-amber-100 text-amber-800',
  transition: 'bg-sky-100 text-sky-800',
  conclusion: 'bg-rose-100 text-rose-800',
  narrative: 'bg-indigo-100 text-indigo-800',
  analysis: 'bg-slate-200 text-slate-800',
  other: 'bg-muted text-muted-foreground',
};

export default function EssayDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [essay, setEssay] = useState<ModelEssay | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The language-points drawer can collapse so the reading surface is
  // less busy when the user just wants to read.
  const [pointsOpen, setPointsOpen] = useState(true);
  const [structureOpen, setStructureOpen] = useState(true);
  // Chinese translation, paragraph-aligned to body. Loaded lazily so
  // import doesn't block on it. Toggle persists across essays.
  const [translation, setTranslation] = useState<string[]>([]);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const [showTranslation, setShowTranslation] = useState<boolean>(() => {
    const v = localStorage.getItem('essay-show-translation');
    return v == null ? true : v === '1';
  });
  useEffect(() => {
    localStorage.setItem('essay-show-translation', showTranslation ? '1' : '0');
  }, [showTranslation]);

  // Selection → add-to-vocab. Mirrors how Reader hooks the bookshelf reader.
  // `articleRef` is the boundary SelectionPopup uses to scope detection so
  // we don't pop up when the user selects text in the sidebar.
  const articleRef = useRef<HTMLElement>(null);
  const [pendingVocab, setPendingVocab] = useState<{ word: string; context: string } | null>(null);

  // Vocab attached to this essay, used to render in-paragraph highlights.
  // Reader does the analogous thing scoped to material_id; here we scope
  // to essay_id so unrelated words from other materials don't bleed in.
  const [vocab, setVocab] = useState<VocabEntry[]>([]);
  async function refreshVocab() {
    if (!id) return;
    try {
      setVocab(await listVocab({ essay_id: Number(id) }));
    } catch {
      // Highlights are a nice-to-have; if the call fails the body still reads.
    }
  }
  useEffect(() => {
    setVocab([]);
    refreshVocab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Paragraph TTS. One shared audio instance so only one paragraph plays
  // at a time — clicking another paragraph swaps the source. Status is
  // tracked per paragraph index for the button icon.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const [ttsStatus, setTtsStatus] = useState<{
    index: number;
    state: 'loading' | 'playing';
  } | null>(null);

  function stopAudio() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }

  useEffect(() => stopAudio, []);

  async function playParagraph(idx: number, text: string) {
    if (!essay) return;
    // Click the currently playing paragraph again → stop.
    if (ttsStatus?.index === idx && ttsStatus.state === 'playing') {
      stopAudio();
      setTtsStatus(null);
      return;
    }
    stopAudio();
    setTtsStatus({ index: idx, state: 'loading' });
    try {
      const res = await fetch('/api/tts/speech', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          essay_id: essay.id,
          language: essay.language,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.addEventListener('ended', () => {
        setTtsStatus(null);
        stopAudio();
      });
      audio.addEventListener('error', () => {
        setTtsStatus(null);
        stopAudio();
      });
      await audio.play();
      setTtsStatus({ index: idx, state: 'playing' });
    } catch (e) {
      setTtsStatus(null);
      alert(`朗读失败:${(e as Error).message}`);
    }
  }

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTranslation([]);
    setTranslateError(null);
    getEssay(Number(id))
      .then((e) => {
        if (cancelled) return;
        setEssay(e);
        // Seed translation from the row if it's already there.
        if (e.translation_zh && e.translation_zh.length > 0) {
          setTranslation(e.translation_zh);
        }
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
  }, [id]);

  // Once the essay is loaded, fire translation lazily if it's missing or
  // out of sync with the current paragraph count. Cheap-cached cases
  // return instantly via the backend's `cached: true` short-circuit.
  useEffect(() => {
    if (!essay) return;
    const paragraphCount = essay.body.split(/\n{2,}/).filter((p) => p.trim()).length;
    const haveSomeTranslation =
      translation.length === paragraphCount && translation.some((s) => s.trim());
    if (haveSomeTranslation || translating) return;
    let cancelled = false;
    setTranslating(true);
    setTranslateError(null);
    translateEssay(essay.id)
      .then((r) => {
        if (!cancelled) setTranslation(r.translation_zh);
      })
      .catch((e: Error) => {
        if (!cancelled) setTranslateError(e.message);
      })
      .finally(() => {
        if (!cancelled) setTranslating(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [essay?.id]);

  async function onDelete() {
    if (!essay) return;
    if (!confirm('删除这篇范文?')) return;
    await deleteEssay(essay.id);
    navigate('/essays');
  }

  /** SelectionPopup hands us the selected text; we look up which
   *  paragraph it came out of, slice out the surrounding sentence and
   *  hand the pair to AddVocabDialog. Same algorithm as Reader.tsx. */
  function handleAddFromSelection(text: string) {
    if (!essay) return;
    const sel = window.getSelection();
    let context = '';
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const startNode = range.startContainer;
      const paraEl = (
        startNode.nodeType === Node.TEXT_NODE
          ? startNode.parentElement
          : (startNode as Element)
      )?.closest('[data-paragraph]') as HTMLElement | null;
      if (paraEl) {
        const paraIdx = Number(paraEl.dataset.paragraph);
        const para =
          paragraphs[paraIdx] ?? paraEl.textContent ?? '';
        const adapter = languageAdapter(essay.language);
        const offset = adapter
          .normalizeTerm(para)
          .indexOf(adapter.normalizeTerm(text));
        context = offset >= 0 ? adapter.extractSentence(para, offset) : para;
      }
    }
    setPendingVocab({ word: text, context: context || text });
  }

  // Split body into paragraphs once; structure_notes are indexed against this.
  const paragraphs = useMemo(() => {
    if (!essay) return [] as string[];
    return essay.body.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  }, [essay]);
  const notesByIndex = useMemo(() => {
    const m = new Map<number, ModelEssay['structure_notes'][number]>();
    if (!essay) return m;
    for (const n of essay.structure_notes) m.set(n.paragraph_index, n);
    return m;
  }, [essay]);

  if (loading)
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-10 text-sm text-muted-foreground">
          加载中...
        </div>
      </main>
    );
  if (error || !essay)
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-10">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/essays">
              <ArrowLeft className="size-4" /> 返回
            </Link>
          </Button>
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error ?? '未找到范文'}
          </div>
        </div>
      </main>
    );

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <div className="mb-4 flex items-center justify-between">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/essays">
              <ArrowLeft className="size-4" /> 返回列表
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
              <input
                type="checkbox"
                checked={showTranslation}
                onChange={(e) => setShowTranslation(e.target.checked)}
                className="accent-primary"
              />
              中文翻译
              {translating && (
                <span className="text-[10px] text-muted-foreground/70">
                  (翻译中…)
                </span>
              )}
            </label>
            {essay.provider && <ProviderBadge provider={essay.provider} />}
            <button
              type="button"
              onClick={onDelete}
              className="text-muted-foreground hover:text-destructive"
              aria-label="删除"
              title="删除这篇范文"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        </div>

        <header className="mb-6 border-b border-border pb-4">
          <h1 className="text-2xl font-medium leading-tight tracking-tight text-foreground">
            {essay.title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
            {essay.author && <span>{essay.author}</span>}
            <span
              className={cn(
                'rounded border px-1.5 py-0.5 text-[10px]',
                SOURCE_TONE[essay.source],
              )}
            >
              {SOURCE_LABEL[essay.source]}
            </span>
            <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-foreground/70">
              {STYLE_LABEL[essay.style] ?? essay.style}
            </span>
            <span>{essay.word_count} 词</span>
            {essay.source_url && (
              <a
                href={essay.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                原文 <ExternalLink className="size-3" />
              </a>
            )}
            {essay.video_url && (
              <a
                href={essay.video_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-rose-700 hover:bg-rose-100"
                title="演讲视频"
              >
                <PlayCircle className="size-3" /> 看演讲
              </a>
            )}
          </div>
          {essay.topic && (
            <p className="mt-2 text-[12px] italic text-muted-foreground">
              生成题目: {essay.topic}
            </p>
          )}
        </header>

        <div className="grid gap-8 lg:grid-cols-[1fr_280px]">
          <article ref={articleRef} className="prose-essay">
            {translateError && (
              <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                翻译失败:{translateError} · 刷新页面可重试
              </div>
            )}
            {paragraphs.map((para, idx) => {
              const note = notesByIndex.get(idx);
              const zh = translation[idx]?.trim();
              const tts = ttsStatus?.index === idx ? ttsStatus.state : 'idle';
              return (
                <div
                  key={idx}
                  data-paragraph={idx}
                  className="group relative mb-5"
                >
                  {note && (
                    <div className="absolute -left-2 top-1.5 hidden -translate-x-full pr-3 text-[10px] lg:block">
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 font-medium',
                          FUNCTION_TONE[note.function] ?? FUNCTION_TONE.other,
                        )}
                      >
                        §{idx + 1} · {FUNCTION_LABEL[note.function] ?? note.function}
                      </span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => playParagraph(idx, para)}
                    title={tts === 'playing' ? '暂停朗读' : '朗读这段'}
                    aria-label="朗读这段"
                    className={cn(
                      'absolute right-0 top-0 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition opacity-0 group-hover:opacity-100',
                      tts === 'playing' && 'opacity-100 text-primary',
                      tts === 'loading' && 'opacity-100',
                      'hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {tts === 'loading' ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : tts === 'playing' ? (
                      <Pause className="size-4" />
                    ) : (
                      <Play className="size-4" />
                    )}
                  </button>
                  <p className="whitespace-pre-wrap pr-8 text-[15.5px] leading-8 text-foreground">
                    {highlightText(
                      para,
                      vocab,
                      undefined,
                      essay.language,
                      undefined,
                      refreshVocab,
                    )}
                  </p>
                  {showTranslation && zh && (
                    <p className="mt-1.5 border-l-2 border-primary/30 bg-primary/[0.04] px-3 py-2 text-[14px] leading-7 text-muted-foreground">
                      {zh}
                    </p>
                  )}
                  {showTranslation && !zh && translating && (
                    <p className="mt-1.5 border-l-2 border-muted bg-muted/30 px-3 py-2 text-[12px] italic text-muted-foreground/70">
                      翻译生成中…
                    </p>
                  )}
                  {note && (
                    <p className="mt-1 text-[11px] leading-4 text-muted-foreground lg:hidden">
                      <span
                        className={cn(
                          'mr-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium',
                          FUNCTION_TONE[note.function] ?? FUNCTION_TONE.other,
                        )}
                      >
                        {FUNCTION_LABEL[note.function] ?? note.function}
                      </span>
                      {note.summary_zh}
                    </p>
                  )}
                </div>
              );
            })}
          </article>

          <aside className="space-y-4">
            <div className="rounded-lg border border-border bg-card">
              <button
                type="button"
                onClick={() => setStructureOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-foreground"
              >
                <span className="inline-flex items-center gap-1.5">
                  <ListTree className="size-4 text-muted-foreground" />
                  段落骨架
                </span>
                <span className="text-xs text-muted-foreground">
                  {structureOpen ? '收起' : '展开'}
                </span>
              </button>
              {structureOpen && (
                <ul className="space-y-1.5 border-t border-border p-3">
                  {paragraphs.map((_, idx) => {
                    const note = notesByIndex.get(idx);
                    if (!note) {
                      return (
                        <li
                          key={idx}
                          className="text-[11px] text-muted-foreground/60"
                        >
                          §{idx + 1} ·
                        </li>
                      );
                    }
                    return (
                      <li key={idx} className="text-[11px] leading-5">
                        <span
                          className={cn(
                            'mr-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium',
                            FUNCTION_TONE[note.function] ?? FUNCTION_TONE.other,
                          )}
                        >
                          §{idx + 1} · {FUNCTION_LABEL[note.function] ?? note.function}
                        </span>
                        <span className="text-muted-foreground">{note.summary_zh}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="rounded-lg border border-border bg-card">
              <button
                type="button"
                onClick={() => setPointsOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-foreground"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Highlighter className="size-4 text-muted-foreground" />
                  可复用语言点
                </span>
                <span className="text-xs text-muted-foreground">
                  {essay.language_points.length} 个
                </span>
              </button>
              {pointsOpen && (
                <ul className="divide-y divide-border border-t border-border">
                  {essay.language_points.map((p, i) => (
                    <li key={i} className="px-3 py-2.5">
                      <p className="text-[13px] font-medium text-foreground">
                        {p.phrase}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                        {p.meaning_zh}
                      </p>
                      {p.usage_note && (
                        <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground/70">
                          {p.usage_note}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      </div>

      <SelectionPopup
        containerRef={articleRef}
        language={essay.language}
        onAdd={handleAddFromSelection}
      />

      {pendingVocab && (
        <AddVocabDialog
          word={pendingVocab.word}
          context={pendingVocab.context}
          essayId={essay.id}
          language={essay.language}
          onClose={() => setPendingVocab(null)}
          onSaved={() => {
            setPendingVocab(null);
            refreshVocab();
          }}
        />
      )}
    </main>
  );
}
