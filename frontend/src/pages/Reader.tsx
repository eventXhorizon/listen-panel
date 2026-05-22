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
  pauseTranscriptionStudy,
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
  MaterialLanguage,
} from '../types';
import VideoPlayer, { type VideoPlayerHandle } from '../components/VideoPlayer';
import SelectionPopup from '../components/SelectionPopup';
import AddVocabDialog from '../components/AddVocabDialog';
import VocabPanel from '../components/VocabPanel';
import { highlightText } from '../lib/highlight';
import { languageAdapter, languageLabel } from '../lib/languages';
import { textSourceLabel } from '../lib/textSources';
import { markOpened } from '../lib/lastOpened';

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

interface ParagraphSegmentGroup {
  text: string;
  segments: TranscriptSegment[];
}

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
const MOBILE_READER_QUERY = '(max-width: 767px)';

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

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const onChange = () => setMatches(mediaQuery.matches);
    onChange();
    mediaQuery.addEventListener('change', onChange);
    return () => mediaQuery.removeEventListener('change', onChange);
  }, [query]);

  return matches;
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

function groupSegmentsForParagraphs(
  segments: TranscriptSegment[],
  paragraphs: string[],
): ParagraphSegmentGroup[] {
  if (segments.length === 0) return [];
  if (paragraphs.length <= 1) {
    return groupPlainSegments(segments).map((group) => ({
      text: group.map((segment) => segment.text).join(' '),
      segments: group,
    }));
  }

  const groups: ParagraphSegmentGroup[] = [];
  let cursor = 0;
  for (const paragraph of paragraphs) {
    const group: TranscriptSegment[] = [];
    let collected = '';
    while (cursor < segments.length) {
      const segment = segments[cursor];
      group.push(segment);
      collected = appendNormalizedText(collected, segment.text);
      cursor += 1;
      if (paragraphContainsSegments(paragraph, collected)) break;
    }
    groups.push({ text: paragraph, segments: group });
  }
  if (cursor < segments.length) {
    const remaining = segments.slice(cursor);
    const last = groups.at(-1);
    if (last) {
      last.segments.push(...remaining);
    } else {
      groups.push({
        text: remaining.map((segment) => segment.text).join(' '),
        segments: remaining,
      });
    }
  }
  return groups.length > 0
    ? groups
    : groupPlainSegments(segments).map((group) => ({
        text: group.map((segment) => segment.text).join(' '),
        segments: group,
      }));
}

function appendNormalizedText(left: string, right: string): string {
  const text = right.trim();
  if (!text) return left;
  return left ? `${left} ${text}` : text;
}

function paragraphContainsSegments(paragraph: string, collected: string): boolean {
  const paragraphText = normalizeStudyText(paragraph);
  const collectedText = normalizeStudyText(collected);
  if (!collectedText) return false;
  if (collectedText.length < paragraphText.length * 0.92) return false;
  return paragraphText.includes(collectedText) || collectedText.includes(paragraphText);
}

function normalizeStudyText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim()
    .toLocaleLowerCase();
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
  const [studyPausing, setStudyPausing] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcriptionErr, setTranscriptionErr] = useState<string | null>(null);
  const [showTypography, setShowTypography] = useState(false);
  const [showMobileMedia, setShowMobileMedia] = useState(false);
  const [typography, setTypography] = useState<ReaderTypography>(loadTypography);
  const isMobileReader = useMediaQuery(MOBILE_READER_QUERY);
  const [resizing, setResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const typographyRef = useRef<HTMLDivElement>(null);
  const articleScrollRef = useRef<HTMLDivElement>(null);
  const playerHandleRef = useRef<VideoPlayerHandle | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [endPauseMs, setEndPauseMs] = useState(0);
  const [loopRange, setLoopRange] = useState<{ start_ms: number; end_ms: number; key: string } | null>(null);
  const loopBusyRef = useRef(false);
  const draggingRef = useRef(false);
  const resizePointerIdRef = useRef<number | null>(null);
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
      markOpened(mid);
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
      // Default to showing study for imported news (provider='youtube_caption') so
      // translations / grammar / usage points appear without an extra click.
      const isNewsImport = latest?.provider === 'youtube_caption';
      const shouldShowStudy =
        latest?.status === 'succeeded' && (loadStudyVisible(mid) || isNewsImport);
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

  async function resumeStudy() {
    if (!job || job.status !== 'succeeded' || job.study_status !== 'pending') return;
    setStudySubmitting(true);
    setStudyErr(null);
    try {
      const updated = await createTranscriptionStudy(job.id);
      setJob(updated);
      if (m) {
        setShowStudy(true);
        saveStudyVisible(m.id, true);
      }
    } catch (e) {
      setStudyErr((e as Error).message);
    } finally {
      setStudySubmitting(false);
    }
  }

  async function pauseStudy() {
    if (!job || job.study_status !== 'running' || studyPausing) return;
    setStudyPausing(true);
    setStudyErr(null);
    try {
      const updated = await pauseTranscriptionStudy(job.id);
      setJob(updated);
    } catch (e) {
      setStudyErr((e as Error).message);
    } finally {
      setStudyPausing(false);
    }
  }

  const updateSplitFromClientX = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setLeftPct(Math.max(28, Math.min(78, pct)));
  }, []);

  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    draggingRef.current = true;
    resizePointerIdRef.current = e.pointerId;
    setResizing(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    updateSplitFromClientX(e.clientX);
    e.preventDefault();
  }, [updateSplitFromClientX]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!draggingRef.current || resizePointerIdRef.current !== e.pointerId) return;
      updateSplitFromClientX(e.clientX);
      e.preventDefault();
    }
    function onUp(e: PointerEvent) {
      if (resizePointerIdRef.current !== e.pointerId) return;
      draggingRef.current = false;
      resizePointerIdRef.current = null;
      setResizing(false);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [updateSplitFromClientX]);

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

  const restoreArticleScroll = useCallback((savedTop: number) => {
    const el = articleScrollRef.current;
    if (!el) return;
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.max(0, Math.min(savedTop, maxTop));
  }, []);

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
  }, [m, restoreArticleScroll]);

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

  useEffect(() => {
    const id = window.setInterval(() => {
      playerHandleRef.current?.setPlaybackRate(playbackRate);
    }, 1000);
    playerHandleRef.current?.setPlaybackRate(playbackRate);
    return () => window.clearInterval(id);
  }, [playbackRate]);

  useEffect(() => {
    if (!loopRange) return;
    loopBusyRef.current = false;
    playerHandleRef.current?.seekTo(loopRange.start_ms / 1000);
    playerHandleRef.current?.play();
    const interval = window.setInterval(() => {
      if (loopBusyRef.current) return;
      const player = playerHandleRef.current;
      if (!player) return;
      const tMs = player.getCurrentTime() * 1000;
      if (tMs + 50 >= loopRange.end_ms) {
        loopBusyRef.current = true;
        player.pause();
        window.setTimeout(() => {
          player.seekTo(loopRange.start_ms / 1000);
          player.play();
          loopBusyRef.current = false;
        }, endPauseMs);
      }
    }, 100);
    return () => {
      window.clearInterval(interval);
      loopBusyRef.current = false;
    };
  }, [loopRange, endPauseMs]);

  function toggleLoop(range: { start_ms: number; end_ms: number; key: string }) {
    setLoopRange((current) => (current && current.key === range.key ? null : range));
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
        const adapter = languageAdapter(m.language);
        const offset = adapter
          .normalizeTerm(para)
          .indexOf(adapter.normalizeTerm(text));
        context = offset >= 0 ? adapter.extractSentence(para, offset) : para;
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
        <div className="max-w-6xl mx-auto px-6 py-10 text-muted-foreground text-sm">
          加载中...
        </div>
      </main>
    );
  }

  const materialText = m.text.trim();
  const hasMaterialText = materialText.length > 0;
  const paragraphs = hasMaterialText
    ? materialText
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  const paragraphSegmentGroups = groupSegmentsForParagraphs(segments, paragraphs);
  const hasStudy = segments.some((segment) => segment.study);
  const isStudyPaused = job?.study_status === 'pending' && job.study_stage === '已暂停';
  const shouldUseTextParagraphs = paragraphs.length > 1 && !showStudy;
  const studyGroups = segments.length === 0 || shouldUseTextParagraphs
    ? []
    : paragraphs.length > 1 && showStudy
      ? paragraphSegmentGroups
      : groupSegmentsForParagraphs(segments, paragraphs);
  const fontFamily =
    FONT_OPTIONS.find((x) => x.value === typography.font)?.family ??
    FONT_OPTIONS[0].family;
  const paragraphStyle: CSSProperties = {
    fontFamily,
    fontSize: `${isMobileReader ? Math.max(20, typography.fontSize) : typography.fontSize}px`,
    lineHeight: typography.lineHeight,
    letterSpacing: `${typography.letterSpacing}em`,
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b border-border bg-card">
        <div className="w-full px-4 py-2 md:px-8 md:py-0 md:h-14 flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-5">
          <div className="min-w-0 flex items-center gap-2">
            <Link
              to="/"
              aria-label="返回书架"
              title="返回书架"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground shrink-0"
            >
              <span aria-hidden="true" className="text-base leading-none">←</span>
            </Link>
            <h1 className="text-[17px] font-semibold text-foreground truncate tracking-tight">
              {m.title}
            </h1>
            <span className="hidden rounded bg-accent px-1.5 py-0.5 text-[11px] text-muted-foreground sm:inline">
              {languageLabel(m.language)}
            </span>
          </div>
          <div className="-mx-4 flex max-w-[calc(100vw-2rem)] items-center gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:max-w-none md:shrink-0 md:overflow-visible md:px-0 md:pb-0">
            <button
              type="button"
              onClick={() => setShowMobileMedia(true)}
              className="inline-flex h-8 shrink-0 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 md:hidden"
            >
              播放
            </button>
            <button
              onClick={() => setHighlightOn((v) => !v)}
              title={highlightOn ? '关闭生词高亮' : '开启生词高亮'}
              className={`inline-flex h-8 shrink-0 items-center rounded-md border px-3 text-xs font-medium transition ${
                highlightOn
                  ? 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20'
                  : 'border-border bg-card text-foreground/85 hover:border-border hover:bg-accent/50'
              }`}
            >
              高亮
            </button>
            <button
              onClick={() => setLeftPct(50)}
              title="重置分栏比例 50:50"
              className="hidden h-8 shrink-0 items-center rounded-md border border-border bg-muted/50 px-3 text-xs font-medium text-foreground/85 hover:bg-accent md:inline-flex"
            >
              50:50
            </button>
            <div ref={typographyRef} className="relative shrink-0">
              <button
                type="button"
                onClick={() => setShowTypography((v) => !v)}
                className="inline-flex h-8 shrink-0 items-center rounded-md border border-primary/30 bg-primary/10 px-3 text-xs font-medium text-primary hover:bg-primary/20"
              >
                排版
              </button>
              {showTypography && (
                <div className="fixed inset-x-4 top-28 z-40 rounded-lg border border-border bg-card p-4 text-sm shadow-xl shadow-foreground/10 md:absolute md:inset-auto md:right-0 md:top-9 md:w-72">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="font-medium text-foreground">阅读排版</span>
                    <button
                      type="button"
                      onClick={() => setTypography(DEFAULT_TYPOGRAPHY)}
                      className="text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      重置
                    </button>
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-muted-foreground">
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
                      className="h-8 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:border-border"
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
              className="inline-flex h-8 shrink-0 items-center rounded-md border border-success/30 bg-success/10 px-3 text-xs font-medium text-success hover:bg-success/20"
            >
              生词 ({vocab.length})
            </button>
            <ShadowingControls
              playbackRate={playbackRate}
              onChangeRate={setPlaybackRate}
              endPauseMs={endPauseMs}
              onChangePause={setEndPauseMs}
              loopActive={loopRange != null}
              onStopLoop={() => setLoopRange(null)}
            />
            <span aria-hidden="true" className="mx-1 hidden h-4 w-px bg-secondary md:block" />
            <button
              onClick={startTranscription}
              disabled={
                transcribing ||
                job?.status === 'queued' ||
                job?.status === 'running'
              }
              className="inline-flex h-8 shrink-0 items-center rounded-md border border-primary/30 bg-primary/10 px-3 text-xs font-medium text-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:border-border disabled:bg-accent disabled:text-muted-foreground/70"
              title="调用局域网 GPU ASR worker 生成原文"
            >
              {transcriptionButtonLabel(job, transcribing)}
            </button>
            {job?.status === 'succeeded' && (
              <>
                <button
                  type="button"
                  onClick={toggleStudy}
                  disabled={studySubmitting}
                  className={`inline-flex h-8 shrink-0 items-center rounded-md border px-3 text-xs font-medium transition disabled:cursor-not-allowed disabled:border-border disabled:bg-accent disabled:text-muted-foreground/70 ${
                    showStudy
                      ? 'border-border bg-accent text-foreground hover:bg-accent/80'
                      : 'border-border bg-card text-foreground/85 hover:border-border hover:bg-accent/50'
                  }`}
                  title="按需生成并显示分段翻译、语法和固定搭配"
                >
                  {studyButtonLabel(job, showStudy, studySubmitting, hasStudy || isStudyPaused)}
                </button>
                {showStudy && job.study_status === 'running' && (
                  <button
                    type="button"
                    onClick={pauseStudy}
                    disabled={studyPausing || job.study_stage === '暂停中'}
                    className="inline-flex h-8 shrink-0 items-center rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground/85 transition hover:border-border hover:bg-accent/50 disabled:cursor-not-allowed disabled:bg-accent disabled:text-muted-foreground/70"
                  >
                    {studyPausing || job.study_stage === '暂停中' ? '暂停中...' : '暂停分析'}
                  </button>
                )}
                {showStudy && job.study_status === 'pending' && (
                  <button
                    type="button"
                    onClick={resumeStudy}
                    disabled={studySubmitting}
                    className="inline-flex h-8 shrink-0 items-center rounded-md border border-border bg-accent px-3 text-xs font-medium text-foreground transition hover:bg-accent/80 disabled:cursor-not-allowed disabled:border-border disabled:bg-accent disabled:text-muted-foreground/70"
                  >
                    {studySubmitting
                      ? '继续中...'
                      : hasStudy || isStudyPaused
                        ? '继续分析'
                        : '开始分析'}
                  </button>
                )}
              </>
            )}
            <Link
              to={`/m/${m.id}/edit`}
              className="inline-flex h-8 shrink-0 items-center rounded-md border border-violet-200 bg-violet-50 px-3 text-xs font-medium text-violet-800 hover:bg-violet-100"
            >
              编辑
            </Link>
          </div>
        </div>
        {transcriptionErr && (
          <div className="border-t border-destructive/20 bg-destructive/5 px-6 py-2 text-sm text-destructive">
            生成原文失败:{' '}
            <span className="font-medium break-words">{transcriptionErr}</span>
          </div>
        )}
        {studyErr && (
          <div className="border-t border-destructive/20 bg-destructive/5 px-6 py-2 text-sm text-destructive">
            翻译分析失败:{' '}
            <span className="font-medium break-words">{studyErr}</span>
          </div>
        )}
        {notesErr && (
          <div className="border-t border-destructive/20 bg-destructive/5 px-6 py-2 text-sm text-destructive">
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
          className="overflow-y-auto bg-card touch-pan-y"
          style={{
            width: isMobileReader ? '100%' : `${leftPct}%`,
            touchAction: isMobileReader ? 'pan-y' : undefined,
            WebkitUserSelect: 'text',
            userSelect: 'text',
          }}
        >
          <article
            ref={articleRef}
            className="max-w-2xl mx-auto px-5 pb-28 pt-7 md:px-10 md:py-10"
          >
            {(hasMaterialText || job || transcriptionErr) && (
              <div className="mb-6 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                {hasMaterialText && (
                  <span>
                    来源: {textSourceLabel(m.text_source)}
                  </span>
                )}
                {job && (
                  <span className={hasMaterialText ? 'ml-3' : undefined}>
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
                  <span className="ml-3 text-destructive">
                    分段加载失败: {segmentsErr}
                  </span>
                )}
                {showStudy && job?.study_status === 'running' && (
                  <StudyProgress job={job} analyzedCount={analyzedSegmentCount(segments)} />
                )}
              </div>
            )}
            {studyGroups.length > 0 ? (
              studyGroups.map((group, i) => (
                group.segments.length > 0 ? (
                  <TranscriptSegmentBlock
                    key={group.segments.map((s) => s.id).join('-')}
                    text={group.text}
                    segments={group.segments}
                    paragraphIndex={i}
                    materialId={m.id}
                    language={m.language}
                    vocab={vocab}
                    highlightOn={highlightOn}
                    paragraphStyle={paragraphStyle}
                    showStudy={showStudy}
                    note={notesByTarget.get(
                      noteKeyFor('segment', group.segments[0]?.id, undefined),
                    )}
                    onOpenNote={openNote}
                    loopActiveKey={loopRange?.key ?? null}
                    onToggleLoop={toggleLoop}
                  />
                ) : (
                  <ParagraphBlock
                    key={`paragraph-${i}`}
                    text={group.text}
                    paragraphIndex={i}
                    materialId={m.id}
                    language={m.language}
                    vocab={vocab}
                    highlightOn={highlightOn}
                    paragraphStyle={paragraphStyle}
                    note={notesByTarget.get(noteKeyFor('paragraph', undefined, i))}
                    onOpenNote={openNote}
                  />
                )
              ))
            ) : paragraphs.length > 0 ? (
              paragraphs.map((p, i) => (
                <ParagraphBlock
                  key={i}
                  text={p}
                  paragraphIndex={i}
                  materialId={m.id}
                  language={m.language}
                  vocab={vocab}
                  highlightOn={highlightOn}
                  paragraphStyle={paragraphStyle}
                  note={notesByTarget.get(noteKeyFor('paragraph', undefined, i))}
                  onOpenNote={openNote}
                />
              ))
            ) : (
              <p className="text-muted-foreground/70 italic">
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
              <div className="mt-12 pt-6 border-t border-border">
                <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-3">
                  备注
                </h3>
                <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap text-[15px]">
                  {m.notes}
                </p>
              </div>
            )}
          </article>
        </div>

        {!isMobileReader && (
          <>
            <div
              onPointerDown={onResizePointerDown}
              className="group relative w-3 shrink-0 cursor-col-resize touch-none select-none"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整左右分栏宽度"
              title="拖动调整左右分栏"
            >
              <div className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 bg-secondary transition group-hover:bg-secondary group-active:bg-muted/500" />
            </div>

            <div
              className="bg-foreground flex flex-col"
              style={{ width: `${100 - leftPct}%` }}
            >
              <div className="flex-1 min-h-0">
                <VideoPlayer
                  materialId={m.id}
                  sourceType={m.source_type}
                  sourceRef={m.source_ref}
                  handleRef={playerHandleRef}
                />
              </div>
            </div>
          </>
        )}
        {isMobileReader && (
          <div
            className={`fixed md:hidden ${
              showMobileMedia
                ? 'inset-0 z-50 bg-black/45'
                : 'inset-x-4 bottom-4 z-30 pointer-events-none'
            }`}
          >
            {showMobileMedia && (
              <button
                type="button"
                aria-label="收起播放面板"
                className="absolute inset-0 cursor-default"
                onClick={() => setShowMobileMedia(false)}
              />
            )}
            <aside
              className={`${
                showMobileMedia
                  ? 'absolute inset-x-0 bottom-0 flex max-h-[86vh] flex-col rounded-t-xl'
                  : 'pointer-events-auto relative rounded-lg'
              } bg-neutral-950 shadow-2xl shadow-neutral-950/40`}
            >
              <div
                className={`flex shrink-0 items-center justify-between px-4 py-3 ${
                  showMobileMedia ? 'border-b border-white/10' : ''
                }`}
              >
                <button
                  type="button"
                  onClick={() => setShowMobileMedia(true)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm font-medium text-white">
                    {m.title}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground/70">
                    {showMobileMedia ? '播放面板' : '点击展开播放面板'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowMobileMedia((v) => !v)}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-card/10 hover:text-white"
                  aria-label={showMobileMedia ? '收起播放面板' : '展开播放面板'}
                >
                  {showMobileMedia ? '×' : '⌃'}
                </button>
              </div>
              <div
                className={
                  showMobileMedia
                    ? 'min-h-[240px] flex-1'
                    : 'fixed -left-[9999px] -top-[9999px] h-px w-px overflow-hidden opacity-0 pointer-events-none'
                }
                aria-hidden={!showMobileMedia}
              >
                <VideoPlayer
                  materialId={m.id}
                  sourceType={m.source_type}
                  sourceRef={m.source_ref}
                  handleRef={playerHandleRef}
                />
              </div>
            </aside>
          </div>
        )}
        {resizing && (
          <div
            className="fixed inset-0 z-50 cursor-col-resize select-none"
            style={{ touchAction: 'none' }}
          />
        )}
      </div>

      <SelectionPopup
        containerRef={articleRef}
        materialId={m.id}
        language={m.language}
        onAdd={handleAddFromSelection}
      />

      {pending && (
        <AddVocabDialog
          word={pending.word}
          context={pending.context}
          materialId={mid}
          language={m.language}
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
  hasStudy: boolean,
): string {
  if (submitting) return '提交分析...';
  if (showStudy) return '隐藏分析';
  if (job?.study_status === 'running') return '显示分析';
  if (job?.study_status === 'pending' && hasStudy) return '继续分析';
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
    <div className="mt-2 rounded-md border border-border bg-card px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span>
          {job.study_stage || '正在分批分析'} · 已完成 {analyzedCount} 段
        </span>
        <span className="font-mono text-foreground">{progress}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-accent0 transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
        长文章会分批处理，已完成的段落会先显示。
      </p>
    </div>
  );
}

function ParagraphBlock({
  text,
  paragraphIndex,
  materialId,
  language,
  vocab,
  highlightOn,
  paragraphStyle,
  note,
  onOpenNote,
}: {
  text: string;
  paragraphIndex: number;
  materialId: number;
  language: MaterialLanguage;
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
      <p className="text-foreground" style={paragraphStyle}>
        {highlightOn ? highlightText(text, vocab, materialId, language) : text}
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
            ? 'border-success/30 bg-success/10 text-success hover:bg-success/15'
            : 'border-border bg-card text-muted-foreground hover:border-border hover:bg-accent/50 hover:text-foreground'
        } select-none`}
      >
        {hasNote ? '笔记' : '+ 笔记'}
      </button>
      {previewOpen && previewText && (
        <span
          className="absolute right-0 top-8 z-40 w-96 rounded-lg border border-border bg-card px-4 py-3 text-left text-sm font-normal leading-6 text-foreground shadow-xl shadow-foreground/10"
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
  text,
  segments,
  paragraphIndex,
  materialId,
  language,
  vocab,
  highlightOn,
  paragraphStyle,
  showStudy,
  note,
  onOpenNote,
  loopActiveKey,
  onToggleLoop,
}: {
  text: string;
  segments: TranscriptSegment[];
  paragraphIndex: number;
  materialId: number;
  language: MaterialLanguage;
  vocab: VocabEntry[];
  highlightOn: boolean;
  paragraphStyle: CSSProperties;
  showStudy: boolean;
  note?: MaterialNote;
  onOpenNote: (
    target: Omit<PendingNote, 'note' | 'rect'>,
    trigger: HTMLElement,
  ) => void;
  loopActiveKey: string | null;
  onToggleLoop: (range: { start_ms: number; end_ms: number; key: string }) => void;
}) {
  const start = segments[0]?.start_ms ?? 0;
  const end = segments[segments.length - 1]?.end_ms ?? start;
  const targetId = segments[0]?.id;
  const loopKey = `seg-block-${paragraphIndex}-${targetId ?? 'x'}`;
  const isLooping = loopActiveKey === loopKey;
  const studyItems = segments
    .map((segment) => ({ segment, study: segment.study }))
    .filter((item): item is { segment: TranscriptSegment; study: SegmentStudy } =>
      isSegmentStudy(item.study),
    );

  return (
    <section
      data-paragraph={paragraphIndex}
      data-paragraph-text={text}
      className="mb-7 scroll-mt-6"
    >
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] font-medium text-muted-foreground/70">
        <div className="flex items-center gap-2">
          <span>{formatTimestamp(start)} - {formatTimestamp(end)}</span>
          <button
            type="button"
            onClick={() => onToggleLoop({ start_ms: start, end_ms: end, key: loopKey })}
            aria-label={isLooping ? '停止循环' : '循环这段'}
            title={isLooping ? '停止循环' : '循环这段(跟读用)'}
            className={`inline-flex h-5 items-center rounded px-1.5 text-[10px] font-medium transition ${
              isLooping
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            {isLooping ? '● 循环中' : '↻ 循环'}
          </button>
        </div>
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
      <p className="text-foreground" style={paragraphStyle}>
        {highlightOn ? highlightText(text, vocab, materialId, language) : text}
      </p>
      {showStudy && studyItems.map(({ segment, study }) => (
        <div
          key={segment.id}
          className="mt-3 rounded-md border border-border bg-accent/60 px-4 py-3 text-sm text-foreground/85"
        >
          {segments.length > 1 && (
            <div className="mb-2 text-[11px] font-medium text-muted-foreground">
              {formatTimestamp(segment.start_ms)} - {formatTimestamp(segment.end_ms)}
            </div>
          )}
          {study.translation_zh && (
            <p className="leading-7 text-foreground">{study.translation_zh}</p>
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
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
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
      <span className="font-medium text-foreground">{point.title}</span>
      <span className="text-muted-foreground">: {point.explanation_zh}</span>
      {point.evidence && (
        <span className="ml-1 text-muted-foreground">例: {point.evidence}</span>
      )}
      {point.tip_zh && (
        <div className="text-xs leading-5 text-muted-foreground">{point.tip_zh}</div>
      )}
    </div>
  );
}

function UsagePointItem({ point }: { point: UsagePoint }) {
  return (
    <div className="leading-6">
      <span className="font-medium text-foreground">{point.phrase}</span>
      <span className="text-muted-foreground">: {point.meaning_zh}</span>
      {point.note_zh && (
        <div className="text-xs leading-5 text-muted-foreground">{point.note_zh}</div>
      )}
      {point.example && (
        <div className="text-xs leading-5 text-muted-foreground">例: {point.example}</div>
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
        className={`absolute flex flex-col bg-card shadow-2xl shadow-foreground/20 ${
          isMobile
            ? 'inset-x-0 bottom-0 max-h-[86vh] rounded-t-xl'
            : 'max-h-[min(620px,calc(100vh-24px))] w-[24rem] rounded-lg border border-border'
        }`}
      >
        <div
          className={`flex shrink-0 items-center justify-between border-b border-border px-4 py-3 ${
            isMobile ? '' : 'cursor-move select-none'
          }`}
          onPointerDown={startDrag}
        >
          <div>
            <div className="text-sm font-semibold text-foreground">{label}</div>
            <div className="text-[11px] text-muted-foreground">
              {target.note ? '已保存' : '新笔记'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mb-4 rounded-md border border-border bg-muted/50 px-3 py-2">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">
              原文
            </div>
            <p className="max-h-28 overflow-y-auto text-sm leading-6 text-foreground/85">
              {target.anchorText}
            </p>
          </div>
          <label className="block">
            <span className="mb-2 block text-xs font-medium text-muted-foreground">
              笔记
            </span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={isMobile ? 8 : 10}
              autoFocus
              className="w-full resize-none rounded-md border border-border bg-card px-3 py-2 text-sm leading-6 text-foreground outline-none focus:border-primary"
              placeholder="写下这里的理解、语法、疑问或补充例句..."
            />
          </label>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={deleteCurrent}
            disabled={!target.note || deleting || saving}
            className="inline-flex h-8 items-center rounded-md border border-destructive/30 bg-card px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:border-border disabled:text-muted-foreground/50"
          >
            {deleting ? '删除中...' : '删除'}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground/85 hover:bg-accent/50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || deleting}
              className="inline-flex h-8 items-center rounded-md border border-success/30 bg-success/10 px-3 text-xs font-medium text-success hover:bg-success/15 disabled:cursor-not-allowed disabled:border-border disabled:bg-accent disabled:text-muted-foreground/70"
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
      <span className="mb-1 flex items-center justify-between text-xs font-medium text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono text-foreground/85">
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
        className="w-full accent-primary"
      />
    </label>
  );
}

function formatSliderValue(value: number, step: number): string {
  if (step >= 1) return String(Math.round(value));
  if (step >= 0.01) return value.toFixed(2);
  return value.toFixed(3);
}

function ShadowingControls({
  playbackRate,
  onChangeRate,
  endPauseMs,
  onChangePause,
  loopActive,
  onStopLoop,
}: {
  playbackRate: number;
  onChangeRate: (r: number) => void;
  endPauseMs: number;
  onChangePause: (ms: number) => void;
  loopActive: boolean;
  onStopLoop: () => void;
}) {
  const RATES = [0.75, 0.85, 1];
  const PAUSES = [
    { value: 0, label: '0' },
    { value: 500, label: '0.5s' },
    { value: 1000, label: '1s' },
    { value: 2000, label: '2s' },
  ];
  return (
    <div className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-1 py-0.5">
      <span className="px-1.5 text-[10px] font-medium text-muted-foreground">速</span>
      {RATES.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChangeRate(r)}
          className={`h-7 rounded px-2 text-[11px] tabular-nums transition ${
            playbackRate === r ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
          }`}
        >
          {r}×
        </button>
      ))}
      <span className="mx-1 hidden h-3 w-px bg-border md:block" />
      <span className="px-1.5 text-[10px] font-medium text-muted-foreground">停</span>
      {PAUSES.map((p) => (
        <button
          key={p.value}
          type="button"
          onClick={() => onChangePause(p.value)}
          className={`h-7 rounded px-2 text-[11px] tabular-nums transition ${
            endPauseMs === p.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
          }`}
        >
          {p.label}
        </button>
      ))}
      {loopActive && (
        <>
          <span className="mx-1 hidden h-3 w-px bg-border md:block" />
          <button
            type="button"
            onClick={onStopLoop}
            className="h-7 rounded bg-primary px-2 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            ● 停止循环
          </button>
        </>
      )}
    </div>
  );
}
