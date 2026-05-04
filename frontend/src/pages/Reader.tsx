import {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  createTranscriptionStudy,
  createTranscriptionJob,
  createNote,
  deleteNote,
  getMaterial,
  getTranscriptionJob,
  getTranscriptionSegments,
  listNotes,
  listTranscriptionJobs,
  listVocab,
  updateNote,
} from '../api';
import type {
  GrammarPoint,
  MaterialNote,
  Material,
  NoteTargetType,
  TranscriptSegment,
  TranscriptionJob,
  UsagePoint,
  VocabEntry,
  SegmentStudy,
} from '../types';
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

interface PendingNote {
  targetType: NoteTargetType;
  targetId?: number;
  paragraphIndex?: number;
  anchorText: string;
  anchorHash: string;
  rect: DOMRectReadOnly;
  note?: MaterialNote;
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
const STUDY_VISIBLE_PREFIX = 'listen-panel:study-visible:';
const SEGMENT_MERGE_GAP_MS = 1200;
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

function studyVisibleKey(materialId: number): string {
  return `${STUDY_VISIBLE_PREFIX}${materialId}`;
}

function loadStudyVisible(materialId: number): boolean {
  try {
    return window.localStorage.getItem(studyVisibleKey(materialId)) === '1';
  } catch {
    return false;
  }
}

function saveStudyVisible(materialId: number, visible: boolean) {
  try {
    window.localStorage.setItem(studyVisibleKey(materialId), visible ? '1' : '0');
  } catch {
    // ignore storage failures
  }
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

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function canMergeSegment(
  previous: TranscriptSegment | undefined,
  current: TranscriptSegment,
): boolean {
  if (!previous) return false;
  if (previous.study || current.study) return false;
  return current.start_ms - previous.end_ms <= SEGMENT_MERGE_GAP_MS;
}

function groupPlainSegments(
  segments: TranscriptSegment[],
): Array<TranscriptSegment[]> {
  const groups: Array<TranscriptSegment[]> = [];
  for (const segment of segments) {
    const lastGroup = groups.at(-1);
    const previous = lastGroup?.at(-1);
    if (lastGroup && canMergeSegment(previous, segment)) {
      lastGroup.push(segment);
    } else {
      groups.push([segment]);
    }
  }
  return groups;
}

function paragraphText(el: HTMLElement): string {
  return el.dataset.paragraphText || el.textContent || '';
}

function isSegmentStudy(value: SegmentStudy | undefined): value is SegmentStudy {
  return Boolean(value);
}

function anchorHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function noteKeyFor(
  targetType: NoteTargetType,
  targetId?: number,
  paragraphIndex?: number,
): string {
  if (targetType === 'segment') return `segment:${targetId ?? ''}`;
  return `paragraph:${paragraphIndex ?? ''}`;
}

function elementRect(el: HTMLElement): DOMRectReadOnly {
  const rect = el.getBoundingClientRect();
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    x: rect.x,
    y: rect.y,
    toJSON: () => ({}),
  };
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
  const [pendingNote, setPendingNote] = useState<PendingNote | null>(null);
  const [showVocabPanel, setShowVocabPanel] = useState(false);
  const [job, setJob] = useState<TranscriptionJob | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [notes, setNotes] = useState<MaterialNote[]>([]);
  const [notesErr, setNotesErr] = useState<string | null>(null);
  const [segmentsErr, setSegmentsErr] = useState<string | null>(null);
  const [showStudy, setShowStudy] = useState(false);
  const [studyErr, setStudyErr] = useState<string | null>(null);
  const [studySubmitting, setStudySubmitting] = useState(false);
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
  const notesByTarget = useMemo(() => {
    const map = new Map<string, MaterialNote>();
    for (const note of notes) {
      map.set(
        noteKeyFor(
          note.target_type,
          note.target_id ?? undefined,
          note.paragraph_index ?? undefined,
        ),
        note,
      );
    }
    return map;
  }, [notes]);

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
      try {
        setNotes(await listNotes(mid));
        setNotesErr(null);
      } catch (e) {
        setNotesErr((e as Error).message);
      }
      const jobs = await listTranscriptionJobs(mid);
      const latest = jobs[0] ?? null;
      setJob(latest);
      const shouldShowStudy = latest?.status === 'succeeded' && loadStudyVisible(mid);
      setShowStudy(shouldShowStudy);
      if (latest?.status === 'succeeded') {
        try {
          const withSegments = await getTranscriptionSegments(latest.id);
          setSegments(withSegments.segments);
          setSegmentsErr(null);
        } catch (e) {
          setSegmentsErr((e as Error).message);
        }
      } else {
        setSegments([]);
        setSegmentsErr(null);
      }
    })();
  }, [mid, navigate]);

  useEffect(() => {
    if (!job || !shouldPollTranscription(job, showStudy)) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await getTranscriptionJob(job.id);
        setJob(next);
        if (next.status === 'failed') {
          setTranscriptionErr(next.error || '转写失败,请检查 ASR worker 配置');
        }
        if (next.status === 'succeeded' && segments.length === 0) {
          setTranscriptionErr(null);
          const refreshed = await getMaterial(mid);
          if (refreshed) setM(refreshed);
          const withSegments = await getTranscriptionSegments(next.id);
          setSegments(withSegments.segments);
          setSegmentsErr(null);
          if (!loadStudyVisible(mid)) {
            setShowStudy(false);
          }
        }
        if (next.status === 'succeeded' && showStudy) {
          const withSegments = await getTranscriptionSegments(next.id);
          setSegments(withSegments.segments);
          setSegmentsErr(null);
        }
      } catch (e) {
        setTranscriptionErr((e as Error).message);
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [job, mid, segments.length, showStudy]);

  async function refreshVocab() {
    setVocab(await listVocab(mid));
  }

  async function startTranscription() {
    if (!m || transcribing) return;
    if (job && (job.status === 'queued' || job.status === 'running')) return;
    setTranscriptionErr(null);
    setStudyErr(null);
    setTranscribing(true);
    try {
      const created = await createTranscriptionJob(m.id);
      setJob(created);
      setSegments([]);
      setSegmentsErr(null);
      setShowStudy(false);
      saveStudyVisible(m.id, false);
    } catch (e) {
      setTranscriptionErr((e as Error).message);
    } finally {
      setTranscribing(false);
    }
  }

  async function toggleStudy() {
    if (!m || !job || job.status !== 'succeeded') return;
    const nextVisible = !showStudy;
    setShowStudy(nextVisible);
    saveStudyVisible(m.id, nextVisible);
    setStudyErr(null);

    if (!nextVisible) return;
    if (job.study_status === 'succeeded') return;

    setStudySubmitting(true);
    try {
      const updated = await createTranscriptionStudy(job.id);
      setJob(updated);
    } catch (e) {
      setStudyErr((e as Error).message);
    } finally {
      setStudySubmitting(false);
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
        const para = paragraphText(paraEl) || paragraphs[paraIdx] || '';
        const offset = para.toLowerCase().indexOf(text.toLowerCase());
        context = offset >= 0 ? findSentence(para, offset) : para;
      }
    }
    setPending({ word: text, context: context || text });
  }

  function openNote(target: Omit<PendingNote, 'note' | 'rect'>, trigger: HTMLElement) {
    const key = noteKeyFor(
      target.targetType,
      target.targetId,
      target.paragraphIndex,
    );
    setPendingNote({
      ...target,
      rect: elementRect(trigger),
      note: notesByTarget.get(key),
    });
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
  const segmentGroups =
    segments.length > 0 ? groupPlainSegments(segments) : [];
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
            {job?.status === 'succeeded' && (
              <button
                type="button"
                onClick={toggleStudy}
                disabled={studySubmitting}
                className={`inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400 ${
                  showStudy
                    ? 'border-indigo-200 bg-indigo-50 text-indigo-800 hover:bg-indigo-100'
                    : 'border-stone-200 bg-white text-stone-700 hover:border-stone-300 hover:bg-stone-50'
                }`}
                title="按需生成并显示分段翻译、语法和固定搭配"
              >
                {studyButtonLabel(job, showStudy, studySubmitting)}
              </button>
            )}
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
        {studyErr && (
          <div className="border-t border-rose-100 bg-rose-50 px-6 py-2 text-sm text-rose-700">
            翻译分析失败:{' '}
            <span className="font-medium break-words">{studyErr}</span>
          </div>
        )}
        {notesErr && (
          <div className="border-t border-rose-100 bg-rose-50 px-6 py-2 text-sm text-rose-700">
            笔记加载失败:{' '}
            <span className="font-medium break-words">{notesErr}</span>
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
          style={{
            width: `${leftPct}%`,
            WebkitUserSelect: 'text',
            userSelect: 'text',
          }}
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
                {job?.status === 'succeeded' && (
                  <span className="ml-3">
                    翻译分析: {studyStatusLabel(job)}
                  </span>
                )}
                {segmentsErr && (
                  <span className="ml-3 text-rose-600">
                    分段加载失败: {segmentsErr}
                  </span>
                )}
                {showStudy && job?.study_status === 'running' && (
                  <StudyProgress job={job} analyzedCount={analyzedSegmentCount(segments)} />
                )}
              </div>
            )}
            {segmentGroups.length > 0 ? (
              segmentGroups.map((group, i) => (
                <TranscriptSegmentBlock
                  key={group.map((s) => s.id).join('-')}
                  group={group}
                  paragraphIndex={i}
                  materialId={m.id}
                  vocab={vocab}
                  highlightOn={highlightOn}
                  paragraphStyle={paragraphStyle}
                  showStudy={showStudy}
                  note={notesByTarget.get(
                    noteKeyFor('segment', group[0]?.id, undefined),
                  )}
                  onOpenNote={openNote}
                />
              ))
            ) : paragraphs.length > 0 ? (
              paragraphs.map((p, i) => (
                <ParagraphBlock
                  key={i}
                  text={p}
                  paragraphIndex={i}
                  materialId={m.id}
                  vocab={vocab}
                  highlightOn={highlightOn}
                  paragraphStyle={paragraphStyle}
                  note={notesByTarget.get(noteKeyFor('paragraph', undefined, i))}
                  onOpenNote={openNote}
                />
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

      {pendingNote && (
        <NoteEditor
          materialId={m.id}
          target={pendingNote}
          onClose={() => setPendingNote(null)}
          onSaved={(note) => {
            setPendingNote(null);
            setNotes((items) => upsertNote(items, note));
            setNotesErr(null);
          }}
          onDeleted={(id) => {
            setPendingNote(null);
            setNotes((items) => items.filter((item) => item.id !== id));
            setNotesErr(null);
          }}
          onError={setNotesErr}
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

function studyButtonLabel(
  job: TranscriptionJob | null,
  showStudy: boolean,
  submitting: boolean,
): string {
  if (submitting) return '提交分析...';
  if (job?.study_status === 'running') return '分析中';
  if (showStudy) return '隐藏分析';
  if (job?.study_status === 'succeeded') return '显示分析';
  return '翻译分析';
}

function shouldPollTranscription(
  job: TranscriptionJob,
  showStudy: boolean,
): boolean {
  if (job.status === 'queued' || job.status === 'running') return true;
  if (job.status !== 'succeeded') return false;
  return showStudy && job.study_status === 'running';
}

function studyStatusLabel(job: TranscriptionJob): string {
  if (job.study_status === 'pending') return '等待中';
  if (job.study_status === 'running') {
    return `${job.study_stage || '分析中'} ${job.study_progress}%`;
  }
  if (job.study_status === 'succeeded') return '已生成';
  if (job.study_status === 'skipped') {
    return job.study_error ? `已跳过 (${job.study_error})` : '已跳过';
  }
  return job.study_error ? `失败 (${job.study_error})` : '失败';
}

function analyzedSegmentCount(segments: TranscriptSegment[]): number {
  return segments.filter((segment) => segment.study).length;
}

function StudyProgress({
  job,
  analyzedCount,
}: {
  job: TranscriptionJob;
  analyzedCount: number;
}) {
  const progress = Math.max(0, Math.min(100, job.study_progress));
  return (
    <div className="mt-2 rounded-md border border-indigo-100 bg-white px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-3 text-[11px] text-stone-500">
        <span>
          {job.study_stage || '正在分批分析'} · 已完成 {analyzedCount} 段
        </span>
        <span className="font-mono text-indigo-700">{progress}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-stone-200">
        <div
          className="h-full rounded-full bg-indigo-500 transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] leading-5 text-stone-500">
        长文章会分批处理，已完成的段落会先显示。
      </p>
    </div>
  );
}

function ParagraphBlock({
  text,
  paragraphIndex,
  materialId,
  vocab,
  highlightOn,
  paragraphStyle,
  note,
  onOpenNote,
}: {
  text: string;
  paragraphIndex: number;
  materialId: number;
  vocab: VocabEntry[];
  highlightOn: boolean;
  paragraphStyle: CSSProperties;
  note?: MaterialNote;
  onOpenNote: (
    target: Omit<PendingNote, 'note' | 'rect'>,
    trigger: HTMLElement,
  ) => void;
}) {
  return (
    <section
      data-paragraph={paragraphIndex}
      data-paragraph-text={text}
      className="mb-6 scroll-mt-6"
    >
      <div className="mb-1 flex justify-end">
        <NoteButton
          hasNote={Boolean(note?.content.trim())}
          preview={note?.content}
          onClick={(trigger) =>
            onOpenNote({
              targetType: 'paragraph',
              paragraphIndex,
              anchorText: text,
              anchorHash: anchorHash(text),
            }, trigger)
          }
        />
      </div>
      <p className="text-stone-800" style={paragraphStyle}>
        {highlightOn ? highlightText(text, vocab, materialId) : text}
      </p>
    </section>
  );
}

function NoteButton({
  hasNote,
  preview,
  onClick,
}: {
  hasNote: boolean;
  preview?: string;
  onClick: (trigger: HTMLElement) => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const previewText = preview?.trim();

  useEffect(() => {
    return () => {
      if (closeTimerRef.current != null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  function openPreview() {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setPreviewOpen(true);
  }

  function scheduleClosePreview() {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = window.setTimeout(() => {
      setPreviewOpen(false);
      closeTimerRef.current = null;
    }, 180);
  }

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={openPreview}
      onMouseLeave={scheduleClosePreview}
      onFocus={openPreview}
      onBlur={scheduleClosePreview}
    >
      <button
        type="button"
        onClick={(e) => onClick(e.currentTarget)}
        title={hasNote ? '编辑段落笔记' : '添加段落笔记'}
        className={`inline-flex h-7 items-center rounded-md border px-2 text-[11px] font-medium transition ${
          hasNote
            ? 'border-lime-200 bg-lime-50 text-lime-800 hover:bg-lime-100'
            : 'border-stone-200 bg-white text-stone-500 hover:border-stone-300 hover:bg-stone-50 hover:text-stone-800'
        } select-none`}
      >
        {hasNote ? '笔记' : '+ 笔记'}
      </button>
      {previewOpen && previewText && (
        <span
          className="absolute right-0 top-8 z-40 w-96 rounded-lg border border-stone-200 bg-white px-4 py-3 text-left text-sm font-normal leading-6 text-stone-800 shadow-xl shadow-stone-900/10"
          onMouseEnter={openPreview}
          onMouseLeave={scheduleClosePreview}
        >
          <span className="block max-h-56 overflow-y-auto whitespace-pre-wrap break-words">
            {previewText}
          </span>
        </span>
      )}
    </span>
  );
}

function TranscriptSegmentBlock({
  group,
  paragraphIndex,
  materialId,
  vocab,
  highlightOn,
  paragraphStyle,
  showStudy,
  note,
  onOpenNote,
}: {
  group: TranscriptSegment[];
  paragraphIndex: number;
  materialId: number;
  vocab: VocabEntry[];
  highlightOn: boolean;
  paragraphStyle: CSSProperties;
  showStudy: boolean;
  note?: MaterialNote;
  onOpenNote: (
    target: Omit<PendingNote, 'note' | 'rect'>,
    trigger: HTMLElement,
  ) => void;
}) {
  const text = group.map((segment) => segment.text).join(' ');
  const start = group[0]?.start_ms ?? 0;
  const end = group[group.length - 1]?.end_ms ?? start;
  const studies = group.map((segment) => segment.study).filter(isSegmentStudy);
  const targetId = group[0]?.id;

  return (
    <section
      data-paragraph={paragraphIndex}
      data-paragraph-text={text}
      className="mb-7 scroll-mt-6"
    >
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] font-medium text-stone-400">
        <span>{formatTimestamp(start)} - {formatTimestamp(end)}</span>
        <NoteButton
          hasNote={Boolean(note?.content.trim())}
          preview={note?.content}
          onClick={(trigger) => {
            if (targetId == null) return;
            onOpenNote({
              targetType: 'segment',
              targetId,
              paragraphIndex,
              anchorText: text,
              anchorHash: anchorHash(text),
            }, trigger);
          }}
        />
      </div>
      <p className="text-stone-800" style={paragraphStyle}>
        {highlightOn ? highlightText(text, vocab, materialId) : text}
      </p>
      {showStudy && studies.map((study, index) => (
        <div
          key={group[index]?.id ?? index}
          className="mt-3 rounded-md border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700"
        >
          {study.translation_zh && (
            <p className="leading-7 text-stone-800">{study.translation_zh}</p>
          )}
          {study.grammar_points.length > 0 && (
            <StudyPointList
              title="语法"
              items={study.grammar_points}
              render={(point) => <GrammarPointItem point={point} />}
            />
          )}
          {study.usage_points.length > 0 && (
            <StudyPointList
              title="搭配"
              items={study.usage_points}
              render={(point) => <UsagePointItem point={point} />}
            />
          )}
        </div>
      ))}
    </section>
  );
}

function StudyPointList<T>({
  title,
  items,
  render,
}: {
  title: string;
  items: T[];
  render: (item: T) => ReactNode;
}) {
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-500">
        {title}
      </div>
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li key={index}>{render(item)}</li>
        ))}
      </ul>
    </div>
  );
}

function GrammarPointItem({ point }: { point: GrammarPoint }) {
  return (
    <div className="leading-6">
      <span className="font-medium text-stone-900">{point.title}</span>
      <span className="text-stone-600">: {point.explanation_zh}</span>
      {point.evidence && (
        <span className="ml-1 text-stone-500">例: {point.evidence}</span>
      )}
      {point.tip_zh && (
        <div className="text-xs leading-5 text-stone-500">{point.tip_zh}</div>
      )}
    </div>
  );
}

function UsagePointItem({ point }: { point: UsagePoint }) {
  return (
    <div className="leading-6">
      <span className="font-medium text-stone-900">{point.phrase}</span>
      <span className="text-stone-600">: {point.meaning_zh}</span>
      {point.note_zh && (
        <div className="text-xs leading-5 text-stone-500">{point.note_zh}</div>
      )}
      {point.example && (
        <div className="text-xs leading-5 text-stone-500">例: {point.example}</div>
      )}
    </div>
  );
}

function NoteEditor({
  materialId,
  target,
  onClose,
  onSaved,
  onDeleted,
  onError,
}: {
  materialId: number;
  target: PendingNote;
  onClose: () => void;
  onSaved: (note: MaterialNote) => void;
  onDeleted: (id: number) => void;
  onError: (error: string | null) => void;
}) {
  const [content, setContent] = useState(target.note?.content ?? '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const label = target.targetType === 'segment' ? '转写分段笔记' : '段落笔记';
  const isMobile = window.innerWidth < 720;
  const [popoverPos, setPopoverPos] = useState(() =>
    notePopoverPosition(target.rect),
  );
  const draggingNoteRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const popoverStyle: CSSProperties = {
    top: popoverPos.top,
    left: popoverPos.left,
  };

  useEffect(() => {
    if (isMobile) return;

    function onPointerMove(e: PointerEvent) {
      const drag = draggingNoteRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      setPopoverPos(
        clampNotePopoverPosition(e.clientX - drag.offsetX, e.clientY - drag.offsetY),
      );
    }

    function onPointerUp(e: PointerEvent) {
      const drag = draggingNoteRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      draggingNoteRef.current = null;
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [isMobile]);

  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (isMobile) return;
    if ((e.target as HTMLElement).closest('button')) return;
    draggingNoteRef.current = {
      pointerId: e.pointerId,
      offsetX: e.clientX - popoverPos.left,
      offsetY: e.clientY - popoverPos.top,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  async function save() {
    setSaving(true);
    try {
      const trimmed = content.trim();
      if (!trimmed && target.note) {
        await deleteNote(target.note.id);
        onDeleted(target.note.id);
        return;
      }
      if (!trimmed) {
        onClose();
        return;
      }
      const saved = target.note
        ? await updateNote(target.note.id, {
            anchor_text: target.anchorText,
            anchor_hash: target.anchorHash,
            content: trimmed,
          })
        : await createNote({
            material_id: materialId,
            target_type: target.targetType,
            target_id: target.targetId,
            paragraph_index: target.paragraphIndex,
            anchor_text: target.anchorText,
            anchor_hash: target.anchorHash,
            content: trimmed,
          });
      onSaved(saved);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function deleteCurrent() {
    if (!target.note) return;
    setDeleting(true);
    try {
      await deleteNote(target.note.id);
      onDeleted(target.note.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/20">
      <button
        type="button"
        aria-label="关闭笔记"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <aside
        style={isMobile ? undefined : popoverStyle}
        className={`absolute flex flex-col bg-white shadow-2xl shadow-stone-950/20 ${
          isMobile
            ? 'inset-x-0 bottom-0 max-h-[86vh] rounded-t-xl'
            : 'max-h-[min(620px,calc(100vh-24px))] w-[24rem] rounded-lg border border-stone-200'
        }`}
      >
        <div
          className={`flex shrink-0 items-center justify-between border-b border-stone-200 px-4 py-3 ${
            isMobile ? '' : 'cursor-move select-none'
          }`}
          onPointerDown={startDrag}
        >
          <div>
            <div className="text-sm font-semibold text-stone-900">{label}</div>
            <div className="text-[11px] text-stone-500">
              {target.note ? '已保存' : '新笔记'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-900"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mb-4 rounded-md border border-stone-200 bg-stone-50 px-3 py-2">
            <div className="mb-1 text-[11px] font-medium text-stone-500">
              原文
            </div>
            <p className="max-h-28 overflow-y-auto text-sm leading-6 text-stone-700">
              {target.anchorText}
            </p>
          </div>
          <label className="block">
            <span className="mb-2 block text-xs font-medium text-stone-500">
              笔记
            </span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={isMobile ? 8 : 10}
              autoFocus
              className="w-full resize-none rounded-md border border-stone-200 bg-white px-3 py-2 text-sm leading-6 text-stone-800 outline-none focus:border-lime-500"
              placeholder="写下这里的理解、语法、疑问或补充例句..."
            />
          </label>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-stone-200 px-4 py-3">
          <button
            type="button"
            onClick={deleteCurrent}
            disabled={!target.note || deleting || saving}
            className="inline-flex h-8 items-center rounded-md border border-rose-200 bg-white px-3 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-stone-200 disabled:text-stone-300"
          >
            {deleting ? '删除中...' : '删除'}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 items-center rounded-md border border-stone-200 bg-white px-3 text-xs font-medium text-stone-700 hover:bg-stone-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || deleting}
              className="inline-flex h-8 items-center rounded-md border border-lime-200 bg-lime-50 px-3 text-xs font-medium text-lime-800 hover:bg-lime-100 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function upsertNote(items: MaterialNote[], note: MaterialNote): MaterialNote[] {
  const index = items.findIndex((item) => item.id === note.id);
  if (index < 0) return [note, ...items];
  const next = [...items];
  next[index] = note;
  return next;
}

interface NotePopoverPosition {
  top: number;
  left: number;
}

function notePopoverPosition(rect: DOMRectReadOnly): NotePopoverPosition {
  const width = 384;
  const margin = 12;
  const estimatedHeight = Math.min(620, window.innerHeight - margin * 2);
  const top = Math.min(
    Math.max(margin, rect.bottom + 8),
    Math.max(margin, window.innerHeight - estimatedHeight - margin),
  );
  const preferredLeft = rect.right - width;
  const left = Math.max(
    margin,
    Math.min(window.innerWidth - width - margin, preferredLeft),
  );
  return { top, left };
}

function clampNotePopoverPosition(left: number, top: number): NotePopoverPosition {
  const width = 384;
  const estimatedHeight = Math.min(620, window.innerHeight - 24);
  const margin = 12;
  return {
    left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
    top: Math.max(margin, Math.min(window.innerHeight - estimatedHeight - margin, top)),
  };
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
