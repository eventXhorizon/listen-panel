import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  RotateCw,
  Search,
} from 'lucide-react';
import { listMaterials, listVocab, logEvent } from '../api';
import type { Material, VocabEntry } from '../types';
import { highlightText } from '../lib/highlight';
import { bbcDate } from '../lib/bbc';
import SelectionPopup from '../components/SelectionPopup';
import AddVocabDialog from '../components/AddVocabDialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/// Shadowing practice: pick an episode from the tree on the left, read the
/// transcript on the right (select a word to add it to vocab, same flow as
/// Reader), and drive the audio from the bar below with speed + A-B loop
/// controls tuned for repeat-after-me practice.
///
/// The catalog is a tree because the BBC 6 Minute English library is huge:
/// "BBC 六分钟英语 → year → episode". Anything without a BBC `date:` note
/// (the user's own uploads/news) lands under "我的材料".

interface Turn {
  speaker: string | null;
  text: string;
}

const NAME_RE = /^[A-Z][A-Za-z'’.-]*(?: [A-Z][A-Za-z'’.-]*){0,2}$/;
const SECTION_RE = /^(vocabulary|glossary|transcript)$/i;

/// BBC transcripts come in two shapes: a colon style where the speaker sits on
/// its own line with a colon ("Kate:"), and a bare style where it's just a name
/// ("Neil"). Bare names are identified by frequency — a host recurs many times
/// through an episode while the title or a vocabulary term does not — so the
/// title and the closing word list don't get mistaken for speakers.
///
/// Wrapped lines are joined back into flowing sentences (the line breaks are
/// PDF artefacts, not meaning).
function parseTurns(text: string): Turn[] {
  const lines = text.split('\n').map((l) => l.trim());

  const colonNames = new Set<string>();
  const freq = new Map<string, number>();
  for (const l of lines) {
    if (!l) continue;
    if (l.endsWith(':')) {
      const n = l.slice(0, -1).trim();
      if (n.length > 0 && n.length <= 24 && NAME_RE.test(n)) colonNames.add(n);
    } else if (l.length <= 24 && NAME_RE.test(l)) {
      freq.set(l, (freq.get(l) ?? 0) + 1);
    }
  }
  const bareNames = new Set(
    [...freq.entries()].filter(([, n]) => n >= 2).map(([name]) => name),
  );

  const turns: Turn[] = [];
  let speaker: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join(' ').trim();
    if (t || speaker) turns.push({ speaker, text: t });
    buf = [];
  };

  for (const l of lines) {
    if (!l) continue;
    const withoutColon = l.endsWith(':') ? l.slice(0, -1).trim() : null;
    if (withoutColon && colonNames.has(withoutColon)) {
      flush();
      speaker = withoutColon;
      continue;
    }
    if (bareNames.has(l)) {
      flush();
      speaker = l;
      continue;
    }
    if (SECTION_RE.test(l)) {
      flush();
      speaker = null;
    }
    buf.push(l);
  }
  flush();
  return turns;
}

/// The dialog asks for 原句 — the sentence a word came from — so narrow the
/// enclosing turn down to the sentence holding the selection. Handing over the
/// whole turn made the add-vocab dialog taller than the viewport and pushed its
/// save button off-screen.
function sentenceAround(block: string, word: string): string {
  if (!block) return '';
  const sentences = block.split(/(?<=[.!?…])\s+/);
  const picked = (sentences.find((s) => s.includes(word)) ?? block).trim();
  return picked.length > 400 ? `${picked.slice(0, 400).trim()}…` : picked;
}

export default function Shadowing() {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [vocab, setVocab] = useState<VocabEntry[]>([]);
  const [add, setAdd] = useState<{ word: string; context: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(['bbc', 'other']),
  );
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMaterials()
      .then((next) => {
        if (cancelled) return;
        setMaterials(next);
        setSelectedId((cur) => cur ?? next[0]?.id ?? null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(
    () => materials.find((m) => m.id === selectedId) ?? null,
    [materials, selectedId],
  );

  const loadVocab = useCallback(() => {
    if (selectedId == null) {
      setVocab([]);
      return;
    }
    listVocab({ material_id: selectedId })
      .then(setVocab)
      .catch(() => setVocab([]));
  }, [selectedId]);

  useEffect(() => {
    loadVocab();
  }, [loadVocab]);

  // BBC episodes grouped by year (newest first); everything else pooled under
  // "我的材料". A search query filters leaves and force-expands the tree.
  const tree = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (m: Material) =>
      !q ||
      m.title.toLowerCase().includes(q) ||
      (m.text || '').toLowerCase().includes(q);

    // year -> month -> materials
    const nested = new Map<string, Map<string, Material[]>>();
    const other: Material[] = [];
    let bbcCount = 0;
    for (const m of materials) {
      if (!match(m)) continue;
      const d = bbcDate(m);
      if (d) {
        const year = d.slice(0, 4);
        const month = d.slice(5, 7);
        const months = nested.get(year) ?? new Map<string, Material[]>();
        nested.set(year, months);
        const arr = months.get(month) ?? [];
        arr.push(m);
        months.set(month, arr);
        bbcCount += 1;
      } else {
        other.push(m);
      }
    }
    const years = [...nested.entries()]
      .map(([year, months]) => ({
        year,
        count: [...months.values()].reduce((n, a) => n + a.length, 0),
        months: [...months.entries()]
          .map(([month, items]) => ({
            month,
            items: items.sort((a, b) =>
              (bbcDate(b) ?? '') < (bbcDate(a) ?? '') ? -1 : 1,
            ),
          }))
          .sort((a, b) => (a.month < b.month ? 1 : -1)),
      }))
      .sort((a, b) => (a.year < b.year ? 1 : -1));
    other.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    return { years, bbcCount, other, searching: q.length > 0 };
  }, [materials, query]);

  function toggle(key: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }
  const isOpen = (key: string) => tree.searching || expanded.has(key);

  /// SelectionPopup hands us only the selected text; recover the surrounding
  /// paragraph from the live DOM selection so the vocab entry keeps its
  /// context sentence. The popup fires this before it clears the selection.
  function handleAddFromSelection(text: string) {
    const sel = window.getSelection();
    const node = sel?.anchorNode ?? null;
    const el = node instanceof Element ? node : (node?.parentElement ?? null);
    const block = el?.closest('[data-para]')?.textContent?.trim() ?? '';
    setAdd({ word: text, context: sentenceAround(block, text) || text });
  }

  const leaf = (m: Material) => {
    const active = m.id === selectedId;
    const date = bbcDate(m);
    return (
      <button
        key={m.id}
        type="button"
        onClick={() => setSelectedId(m.id)}
        className={cn(
          'flex w-full items-baseline gap-2 py-1.5 pl-12 pr-3 text-left transition hover:bg-accent',
          active && 'bg-accent',
        )}
      >
        <span
          className={cn(
            'line-clamp-1 flex-1 text-[13px]',
            active ? 'font-medium text-foreground' : 'text-foreground/85',
          )}
        >
          {m.title}
        </span>
        {date && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {date.slice(5)}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* Catalog tree */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-card">
        <div className="border-b border-border p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索标题或原文"
              className="pl-9"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {loading ? (
            <div className="p-4 text-sm text-muted-foreground">加载中...</div>
          ) : tree.years.length === 0 && tree.other.length === 0 ? (
            <div className="p-4 text-sm leading-relaxed text-muted-foreground">
              {query
                ? '没有匹配的材料。'
                : '还没有材料。导入 BBC 六分钟英语后会出现在这里。'}
            </div>
          ) : (
            <>
              {tree.years.length > 0 && (
                <div>
                  <GroupRow
                    label="BBC 六分钟英语"
                    count={tree.bbcCount}
                    open={isOpen('bbc')}
                    onToggle={() => toggle('bbc')}
                  />
                  {isOpen('bbc') &&
                    tree.years.map((yg) => (
                      <div key={yg.year}>
                        <YearRow
                          year={yg.year}
                          count={yg.count}
                          open={isOpen(`bbc:${yg.year}`)}
                          onToggle={() => toggle(`bbc:${yg.year}`)}
                        />
                        {isOpen(`bbc:${yg.year}`) &&
                          yg.months.map((mg) => (
                            <div key={mg.month}>
                              <MonthRow
                                month={mg.month}
                                count={mg.items.length}
                                open={isOpen(`bbc:${yg.year}:${mg.month}`)}
                                onToggle={() =>
                                  toggle(`bbc:${yg.year}:${mg.month}`)
                                }
                              />
                              {isOpen(`bbc:${yg.year}:${mg.month}`) &&
                                mg.items.map(leaf)}
                            </div>
                          ))}
                      </div>
                    ))}
                </div>
              )}
              {tree.other.length > 0 && (
                <div className="mt-1">
                  <GroupRow
                    label="我的材料"
                    count={tree.other.length}
                    open={isOpen('other')}
                    onToggle={() => toggle('other')}
                  />
                  {isOpen('other') && tree.other.map(leaf)}
                </div>
              )}
            </>
          )}
        </div>
      </aside>

      {/* Transcript + playback */}
      <div className="flex min-h-0 flex-1 flex-col">
        {selected ? (
          <>
            <div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto">
              <div className="w-full max-w-4xl py-8 pl-16 pr-8">
                <div className="mb-5 flex flex-wrap items-center gap-3">
                  <h1 className="text-xl font-semibold text-foreground">
                    {selected.title}
                  </h1>
                  {bbcDate(selected) && (
                    <Badge
                      variant="outline"
                      className="border-border bg-background text-muted-foreground"
                    >
                      {bbcDate(selected)}
                    </Badge>
                  )}
                </div>
                <article className="space-y-4 text-[15px] leading-8 text-foreground">
                  {parseTurns(selected.text).map((turn, i) => {
                    const render = (t: string) =>
                      highlightText(
                        t,
                        vocab,
                        selected.id,
                        selected.language,
                        undefined,
                        loadVocab,
                      );
                    if (turn.speaker) {
                      // Join PDF line-wraps so the utterance flows and wraps by width.
                      const flow = turn.text.replace(/\s*\n\s*/g, ' ');
                      return (
                        <div key={i} className="flex items-baseline gap-3 sm:gap-6">
                          <div className="w-20 shrink-0 font-semibold text-foreground sm:w-28">
                            {turn.speaker}
                          </div>
                          <p data-para="1" className="min-w-0 flex-1">
                            {render(flow)}
                          </p>
                        </div>
                      );
                    }
                    return (
                      <p key={i} data-para="1" className="whitespace-pre-line">
                        {render(turn.text)}
                      </p>
                    );
                  })}
                </article>
              </div>
            </div>
            {/* Remount on episode switch: fresh audio element + reset controls. */}
            <PlaybackBar
              key={selected.id}
              src={`/api/media/${encodeURIComponent(selected.source_ref)}`}
              title={selected.title}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {loading ? '加载中...' : '从左侧选择一篇开始跟读'}
          </div>
        )}
      </div>

      <SelectionPopup
        containerRef={transcriptRef}
        materialId={selected?.id}
        language={selected?.language ?? 'en'}
        onAdd={handleAddFromSelection}
      />
      {add && selected && (
        <AddVocabDialog
          word={add.word}
          context={add.context}
          materialId={selected.id}
          language={selected.language}
          onClose={() => setAdd(null)}
          onSaved={() => {
            setAdd(null);
            loadVocab();
          }}
        />
      )}
    </div>
  );
}

function GroupRow({
  label,
  count,
  open,
  onToggle,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-1 px-2 py-1.5 text-left transition hover:bg-accent"
    >
      {open ? (
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="flex-1 text-sm font-medium text-foreground">{label}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {count}
      </span>
    </button>
  );
}

function YearRow({
  year,
  count,
  open,
  onToggle,
}: {
  year: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-1 py-1.5 pl-5 pr-2 text-left transition hover:bg-accent"
    >
      {open ? (
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="flex-1 text-[13px] text-foreground/90">{year}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {count}
      </span>
    </button>
  );
}

function MonthRow({
  month,
  count,
  open,
  onToggle,
}: {
  month: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-1 py-1.5 pl-8 pr-2 text-left transition hover:bg-accent"
    >
      {open ? (
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="flex-1 text-[13px] text-foreground/80">{month}月</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {count}
      </span>
    </button>
  );
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec)) return '0:00';
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/// Audio player tuned for shadowing: play/pause, ±5s nudges, a speed row
/// (slowing down is the single most useful shadowing aid), and an A-B loop for
/// drilling one tricky sentence over and over.
function PlaybackBar({ src, title }: { src: string; title: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [rate, setRate] = useState(1);
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  const [loopOn, setLoopOn] = useState(false);

  // The timeupdate handler reads the latest loop bounds without re-binding.
  const loop = useRef({ a: loopA, b: loopB, on: loopOn });
  loop.current = { a: loopA, b: loopB, on: loopOn };

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  function onTime() {
    const el = audioRef.current;
    if (!el) return;
    const { a, b, on } = loop.current;
    if (on && a != null && b != null && b > a && el.currentTime >= b) {
      el.currentTime = a;
    }
    setCur(el.currentTime);
  }

  function toggle() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }

  function nudge(delta: number) {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + delta));
    setCur(el.currentTime);
  }

  const canLoop = loopA != null && loopB != null && loopB > loopA;

  const chip =
    'inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground transition hover:bg-accent disabled:opacity-40 disabled:hover:bg-background';

  return (
    <div className="shrink-0 border-t border-border bg-card px-4 py-3">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={(e) => {
          setPlaying(true);
          // Replaying buffered audio makes no request of its own, so the
          // server only learns about it if the page says so.
          const { a, b, on } = loop.current;
          const seg =
            on && a != null && b != null && b > a
              ? ` 循环 ${fmtTime(a)}-${fmtTime(b)}`
              : '';
          const speed = rate === 1 ? '' : ` ${rate}×`;
          logEvent(
            `跟读播放《${title}》 ${fmtTime(e.currentTarget.currentTime)}${seg}${speed}`,
          );
        }}
        onPause={() => setPlaying(false)}
        onTimeUpdate={onTime}
        onLoadedMetadata={(e) => {
          setDur(e.currentTarget.duration);
          e.currentTarget.playbackRate = rate;
        }}
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? '暂停' : '播放'}
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:bg-primary/90"
        >
          {playing ? (
            <Pause className="size-5" />
          ) : (
            <Play className="size-5 translate-x-0.5" />
          )}
        </button>
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {fmtTime(cur)}
        </span>
        <input
          type="range"
          min={0}
          max={dur || 0}
          step={0.1}
          value={cur}
          onChange={(e) => {
            const el = audioRef.current;
            if (!el) return;
            el.currentTime = Number(e.target.value);
            setCur(el.currentTime);
          }}
          className="h-1.5 flex-1 cursor-pointer accent-primary"
        />
        <span className="w-10 shrink-0 text-xs tabular-nums text-muted-foreground">
          {fmtTime(dur)}
        </span>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => nudge(-5)} className={chip}>
          <RotateCcw className="size-3.5" />
          5s
        </button>
        <button type="button" onClick={() => nudge(5)} className={chip}>
          <RotateCw className="size-3.5" />
          5s
        </button>

        <div className="ml-1 flex items-center gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setRate(s)}
              className={cn(
                'rounded-md px-2 py-1 text-xs tabular-nums transition',
                rate === s
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-accent',
              )}
            >
              {s}×
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setLoopA(cur)}
            className={chip}
            title="设为循环起点"
          >
            A{loopA != null ? ` ${fmtTime(loopA)}` : ''}
          </button>
          <button
            type="button"
            onClick={() => setLoopB(cur)}
            className={chip}
            title="设为循环终点"
          >
            B{loopB != null ? ` ${fmtTime(loopB)}` : ''}
          </button>
          <button
            type="button"
            onClick={() => setLoopOn((v) => !v)}
            disabled={!canLoop}
            className={cn(
              chip,
              loopOn && canLoop && 'border-primary bg-primary text-primary-foreground hover:bg-primary/90',
            )}
            title="A-B 循环"
          >
            <Repeat className="size-3.5" />
            循环
          </button>
          {(loopA != null || loopB != null) && (
            <button
              type="button"
              onClick={() => {
                setLoopA(null);
                setLoopB(null);
                setLoopOn(false);
              }}
              className={chip}
            >
              清除
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
