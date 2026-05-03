import {
  useEffect,
  useState,
  useRef,
  useCallback,
  type CSSProperties,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  createTranscriptionJob,
  getMaterial,
  getTranscriptionJob,
  listTranscriptionJobs,
  listVocab,
} from '../api';
import type { Material, TranscriptionJob, VocabEntry } from '../types';
import VideoPlayer from '../components/VideoPlayer';
import SelectionPopup from '../components/SelectionPopup';
import AddVocabDialog from '../components/AddVocabDialog';
import VocabPanel from '../components/VocabPanel';
import { findSentence } from '../lib/sentence';
import { highlightText } from '../lib/highlight';

interface PendingAdd {
  word: string;
  context: string;
}

type ReaderFont =
  | 'system'
  | 'apple'
  | 'pingfang'
  | 'microsoftYahei'
  | 'inter'
  | 'arial'
  | 'serif'
  | 'georgia'
  | 'times'
  | 'mono';

interface ReaderTypography {
  font: ReaderFont;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
}

const TYPOGRAPHY_STORAGE_KEY = 'listen-panel.readerTypography';
const ARTICLE_SCROLL_PREFIX = 'listen-panel:article-scroll:';
const DEFAULT_TYPOGRAPHY: ReaderTypography = {
  font: 'system',
  fontSize: 17,
  lineHeight: 1.85,
  letterSpacing: 0,
};

const FONT_OPTIONS: Array<{
  value: ReaderFont;
  label: string;
  family: string;
}> = [
  {
    value: 'system',
    label: '系统',
    family: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },
  {
    value: 'apple',
    label: 'Apple / SF',
    family:
      'SF Pro Text, SF Pro Display, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif',
  },
  {
    value: 'pingfang',
    label: '苹方',
    family:
      '"PingFang SC", "Hiragino Sans GB", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  {
    value: 'microsoftYahei',
    label: '微软雅黑',
    family: '"Microsoft YaHei", "微软雅黑", "Segoe UI", Arial, sans-serif',
  },
  {
    value: 'inter',
    label: 'Inter',
    family: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  {
    value: 'arial',
    label: 'Arial',
    family: 'Arial, Helvetica, sans-serif',
  },
  {
    value: 'serif',
    label: '衬线',
    family: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  },
  {
    value: 'georgia',
    label: 'Georgia',
    family: 'Georgia, Cambria, "Times New Roman", Times, serif',
  },
  {
    value: 'times',
    label: 'Times',
    family: '"Times New Roman", Times, ui-serif, serif',
  },
  {
    value: 'mono',
    label: '等宽',
    family: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  },
];

function loadTypography(): ReaderTypography {
  try {
    const raw = window.localStorage.getItem(TYPOGRAPHY_STORAGE_KEY);
    if (!raw) return DEFAULT_TYPOGRAPHY;
    const parsed = JSON.parse(raw) as Partial<ReaderTypography>;
    const font = isReaderFont(parsed.font)
      ? parsed.font
      : DEFAULT_TYPOGRAPHY.font;
    return {
      font,
      fontSize: clampNumber(parsed.fontSize, 14, 24, DEFAULT_TYPOGRAPHY.fontSize),
      lineHeight: clampNumber(
        parsed.lineHeight,
        1.35,
        2.4,
        DEFAULT_TYPOGRAPHY.lineHeight,
      ),
      letterSpacing: clampNumber(
        parsed.letterSpacing,
        0,
        0.08,
        DEFAULT_TYPOGRAPHY.letterSpacing,
      ),
    };
  } catch {
    return DEFAULT_TYPOGRAPHY;
  }
}

function isReaderFont(value: unknown): value is ReaderFont {
  return FONT_OPTIONS.some((x) => x.value === value);
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function articleScrollKey(materialId: number): string {
  return `${ARTICLE_SCROLL_PREFIX}${materialId}`;
}

function loadArticleScroll(materialId: number): number | null {
  try {
    const raw = window.localStorage.getItem(articleScrollKey(materialId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { top?: unknown };
    return typeof parsed.top === 'number' && Number.isFinite(parsed.top)
      ? parsed.top
      : null;
  } catch {
    return null;
  }
}

function saveArticleScroll(materialId: number, top: number) {
  if (!Number.isFinite(top)) return;
  window.localStorage.setItem(
    articleScrollKey(materialId),
    JSON.stringify({ top: Math.max(0, top), updated_at: Date.now() }),
  );
}

export default function Reader() {
  const { id } = useParams();
  const mid = Number(id);
  const navigate = useNavigate();
  const [m, setM] = useState<Material | null>(null);
  const [vocab, setVocab] = useState<VocabEntry[]>([]);
  const [leftPct, setLeftPct] = useState(50);
  const [highlightOn, setHighlightOn] = useState(true);
  const [pending, setPending] = useState<PendingAdd | null>(null);
  const [showVocabPanel, setShowVocabPanel] = useState(false);
  const [job, setJob] = useState<TranscriptionJob | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcriptionErr, setTranscriptionErr] = useState<string | null>(null);
  const [showTypography, setShowTypography] = useState(false);
  const [typography, setTypography] = useState<ReaderTypography>(loadTypography);
  const containerRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const typographyRef = useRef<HTMLDivElement>(null);
  const articleScrollRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const restoredScrollForRef = useRef<number | null>(null);
  const lastScrollSavedAtRef = useRef(0);

  useEffect(() => {
    if (Number.isNaN(mid)) {
      navigate('/');
      return;
    }
    (async () => {
      const data = await getMaterial(mid);
      if (!data) {
        navigate('/');
        return;
      }
      setM(data);
      setVocab(await listVocab(mid));
      const jobs = await listTranscriptionJobs(mid);
      setJob(jobs[0] ?? null);
    })();
  }, [mid, navigate]);

  useEffect(() => {
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await getTranscriptionJob(job.id);
        setJob(next);
        if (next.status === 'failed') {
          setTranscriptionErr(next.error || '转写失败,请检查 ASR worker 配置');
        }
        if (next.status === 'succeeded') {
          setTranscriptionErr(null);
          const refreshed = await getMaterial(mid);
          if (refreshed) setM(refreshed);
        }
      } catch (e) {
        setTranscriptionErr((e as Error).message);
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [job, mid]);

  async function refreshVocab() {
    setVocab(await listVocab(mid));
  }

  async function startTranscription() {
    if (!m || transcribing) return;
    if (job && (job.status === 'queued' || job.status === 'running')) return;
    setTranscriptionErr(null);
    setTranscribing(true);
    try {
      const created = await createTranscriptionJob(m.id);
      setJob(created);
    } catch (e) {
      setTranscriptionErr((e as Error).message);
    } finally {
      setTranscribing(false);
    }
  }

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    draggingRef.current = true;
    e.preventDefault();
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.max(28, Math.min(78, pct)));
    }
    function onUp() {
      draggingRef.current = false;
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      TYPOGRAPHY_STORAGE_KEY,
      JSON.stringify(typography),
    );
  }, [typography]);

  useEffect(() => {
    if (!showTypography) return;
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (typographyRef.current?.contains(target)) return;
      setShowTypography(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [showTypography]);

  useEffect(() => {
    if (!m) return;
    if (restoredScrollForRef.current === m.id) return;
    restoredScrollForRef.current = m.id;

    const savedTop = loadArticleScroll(m.id);
    if (savedTop == null) return;

    let nextFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      restoreArticleScroll(savedTop);
      nextFrame = window.requestAnimationFrame(() => restoreArticleScroll(savedTop));
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (nextFrame) window.cancelAnimationFrame(nextFrame);
    };
  }, [m]);

  useEffect(() => {
    if (!m) return;
    const materialId = m.id;
    const saveCurrent = () => {
      const el = articleScrollRef.current;
      if (el) saveArticleScroll(materialId, el.scrollTop);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') saveCurrent();
    };
    window.addEventListener('beforeunload', saveCurrent);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      saveCurrent();
      window.removeEventListener('beforeunload', saveCurrent);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [m]);

  function restoreArticleScroll(savedTop: number) {
    const el = articleScrollRef.current;
    if (!el) return;
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.max(0, Math.min(savedTop, maxTop));
  }

  function handleArticleScroll(e: React.UIEvent<HTMLDivElement>) {
    if (!m) return;
    const now = Date.now();
    if (now - lastScrollSavedAtRef.current < 500) return;
    lastScrollSavedAtRef.current = now;
    saveArticleScroll(m.id, e.currentTarget.scrollTop);
  }

  function handleAddFromSelection(text: string) {
    if (!m) return;
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
        const paragraphs = (m.text || '')
          .split(/\n{2,}/)
          .map((p) => p.trim())
          .filter(Boolean);
        const para = paragraphs[paraIdx] ?? '';
        const offset = para.toLowerCase().indexOf(text.toLowerCase());
        context = offset >= 0 ? findSentence(para, offset) : para;
      }
    }
    setPending({ word: text, context: context || text });
  }

  if (!m) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-10 text-stone-500 text-sm">
          加载中...
        </div>
      </main>
    );
  }

  const paragraphs = m.text
    ? m.text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  const fontFamily =
    FONT_OPTIONS.find((x) => x.value === typography.font)?.family ??
    FONT_OPTIONS[0].family;
  const paragraphStyle: CSSProperties = {
    fontFamily,
    fontSize: `${typography.fontSize}px`,
    lineHeight: typography.lineHeight,
    letterSpacing: `${typography.letterSpacing}em`,
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b border-stone-200 bg-white">
        <div className="w-full px-8 h-14 flex items-center justify-between gap-5">
          <div className="min-w-0 flex items-center gap-2">
            <Link
              to="/"
              aria-label="返回书架"
              title="返回书架"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-900 shrink-0"
            >
              <span aria-hidden="true" className="text-base leading-none">←</span>
            </Link>
            <h1 className="text-[17px] font-semibold text-stone-900 truncate tracking-tight">
              {m.title}
            </h1>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => setHighlightOn((v) => !v)}
              title={highlightOn ? '关闭生词高亮' : '开启生词高亮'}
              className={`inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition ${
                highlightOn
                  ? 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
                  : 'border-stone-200 bg-white text-stone-700 hover:border-stone-300 hover:bg-stone-50'
              }`}
            >
              高亮
            </button>
            <button
              onClick={() => setLeftPct(50)}
              title="重置分栏比例 50:50"
              className="inline-flex h-8 items-center rounded-md border border-stone-200 bg-stone-50 px-3 text-xs font-medium text-stone-700 hover:bg-stone-100"
            >
              50:50
            </button>
            <div ref={typographyRef} className="relative">
              <button
                type="button"
                onClick={() => setShowTypography((v) => !v)}
                className="inline-flex h-8 items-center rounded-md border border-teal-200 bg-teal-50 px-3 text-xs font-medium text-teal-800 hover:bg-teal-100"
              >
                排版
              </button>
              {showTypography && (
                <div className="absolute right-0 top-9 z-40 w-72 rounded-lg border border-stone-200 bg-white p-4 text-sm shadow-xl shadow-stone-900/10">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="font-medium text-stone-900">阅读排版</span>
                    <button
                      type="button"
                      onClick={() => setTypography(DEFAULT_TYPOGRAPHY)}
                      className="text-xs font-medium text-stone-500 hover:text-stone-900"
                    >
                      重置
                    </button>
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-stone-500">
                      字体
                    </span>
                    <select
                      value={typography.font}
                      onChange={(e) =>
                        setTypography((v) => ({
                          ...v,
                          font: e.target.value as ReaderFont,
                        }))
                      }
                      className="h-8 w-full rounded-md border border-stone-200 bg-white px-2 text-sm text-stone-800 focus:outline-none focus:border-stone-400"
                    >
                      {FONT_OPTIONS.map((font) => (
                        <option key={font.value} value={font.value}>
                          {font.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <TypographySlider
                    label="字号"
                    value={typography.fontSize}
                    min={14}
                    max={24}
                    step={1}
                    suffix="px"
                    onChange={(fontSize) =>
                      setTypography((v) => ({ ...v, fontSize }))
                    }
                  />
                  <TypographySlider
                    label="行距"
                    value={typography.lineHeight}
                    min={1.35}
                    max={2.4}
                    step={0.05}
                    onChange={(lineHeight) =>
                      setTypography((v) => ({ ...v, lineHeight }))
                    }
                  />
                  <TypographySlider
                    label="字距"
                    value={typography.letterSpacing}
                    min={0}
                    max={0.08}
                    step={0.005}
                    suffix="em"
                    onChange={(letterSpacing) =>
                      setTypography((v) => ({ ...v, letterSpacing }))
                    }
                  />
                </div>
              )}
            </div>
            <button
              onClick={() => setShowVocabPanel(true)}
              className="inline-flex h-8 items-center rounded-md border border-emerald-200 bg-emerald-50 px-3 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
            >
              生词 ({vocab.length})
            </button>
            <span aria-hidden="true" className="mx-1 h-4 w-px bg-stone-200" />
            <button
              onClick={startTranscription}
              disabled={
                transcribing ||
                job?.status === 'queued' ||
                job?.status === 'running'
              }
              className="inline-flex h-8 items-center rounded-md border border-sky-200 bg-sky-50 px-3 text-xs font-medium text-sky-800 hover:bg-sky-100 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"
              title="调用局域网 GPU ASR worker 生成原文"
            >
              {transcriptionButtonLabel(job, transcribing)}
            </button>
            <Link
              to={`/m/${m.id}/edit`}
              className="inline-flex h-8 items-center rounded-md border border-violet-200 bg-violet-50 px-3 text-xs font-medium text-violet-800 hover:bg-violet-100"
            >
              编辑
            </Link>
          </div>
        </div>
        {transcriptionErr && (
          <div className="border-t border-rose-100 bg-rose-50 px-6 py-2 text-sm text-rose-700">
            生成原文失败:{' '}
            <span className="font-medium break-words">{transcriptionErr}</span>
          </div>
        )}
      </div>

      <div
        ref={containerRef}
        className="flex-1 flex overflow-hidden min-h-0"
      >
        <div
          ref={articleScrollRef}
          onScroll={handleArticleScroll}
          className="overflow-y-auto bg-white"
          style={{ width: `${leftPct}%` }}
        >
          <article
            ref={articleRef}
            className="px-10 py-10 max-w-2xl mx-auto"
          >
            {(job || transcriptionErr) && (
              <div className="mb-6 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600">
                {job && (
                  <span>
                    转写:{' '}
                    {job.status === 'queued'
                      ? '排队中'
                      : job.status === 'running'
                        ? `运行中 ${job.progress}%`
                        : job.status === 'succeeded'
                          ? '已完成'
                          : '失败'}
                  </span>
                )}
              </div>
            )}
            {paragraphs.length > 0 ? (
              paragraphs.map((p, i) => (
                <p
                  key={i}
                  data-paragraph={i}
                  className="mb-5 text-stone-800"
                  style={paragraphStyle}
                >
                  {highlightOn ? highlightText(p, vocab, m.id) : p}
                </p>
              ))
            ) : (
              <p className="text-stone-400 italic">
                尚无原文。
                <Link
                  to={`/m/${m.id}/edit`}
                  className="underline ml-1"
                >
                  点此添加
                </Link>
              </p>
            )}
            {m.notes && (
              <div className="mt-12 pt-6 border-t border-stone-200">
                <h3 className="text-xs uppercase tracking-wider text-stone-500 mb-3">
                  备注
                </h3>
                <p className="text-stone-600 leading-relaxed whitespace-pre-wrap text-[15px]">
                  {m.notes}
                </p>
              </div>
            )}
          </article>
        </div>

        <div
          onMouseDown={onMouseDown}
          className="w-1 bg-stone-200 hover:bg-stone-400 active:bg-stone-500 cursor-col-resize transition shrink-0"
        />

        <div
          className="bg-stone-900 flex flex-col"
          style={{ width: `${100 - leftPct}%` }}
        >
          <div className="flex-1 min-h-0">
            <VideoPlayer
              materialId={m.id}
              sourceType={m.source_type}
              sourceRef={m.source_ref}
            />
          </div>
        </div>
      </div>

      <SelectionPopup
        containerRef={articleRef}
        materialId={m.id}
        onAdd={handleAddFromSelection}
      />

      {pending && (
        <AddVocabDialog
          word={pending.word}
          context={pending.context}
          materialId={mid}
          onClose={() => setPending(null)}
          onSaved={() => {
            setPending(null);
            refreshVocab();
          }}
        />
      )}

      {showVocabPanel && (
        <VocabPanel
          items={vocab}
          onClose={() => setShowVocabPanel(false)}
          onChange={refreshVocab}
        />
      )}
    </div>
  );
}

function transcriptionButtonLabel(
  job: TranscriptionJob | null,
  transcribing: boolean,
): string {
  if (transcribing) return '提交中...';
  if (job?.status === 'queued') return '转写排队中';
  if (job?.status === 'running') return `转写中 ${job.progress}%`;
  if (job?.status === 'succeeded') return '重转写';
  return '转写';
}

function TypographySlider({
  label,
  value,
  min,
  max,
  step,
  suffix = '',
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="mt-3 block">
      <span className="mb-1 flex items-center justify-between text-xs font-medium text-stone-500">
        <span>{label}</span>
        <span className="font-mono text-stone-700">
          {formatSliderValue(value, step)}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-teal-700"
      />
    </label>
  );
}

function formatSliderValue(value: number, step: number): string {
  if (step >= 1) return String(Math.round(value));
  if (step >= 0.01) return value.toFixed(2);
  return value.toFixed(3);
}
