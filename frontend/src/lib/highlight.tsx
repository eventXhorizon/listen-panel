import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { VocabEntry } from '../types';

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

const POP_W = 352;       // w-[22rem]
const POP_H_EST = 320;   // 估值,用于决定上下翻转
const VIEWPORT_M = 12;   // 视口边距

interface Pos {
  top: number;
  left: number;
}

interface HighlightedWordProps {
  matched: string;
  entry?: VocabEntry;
  onPick?: (entry: VocabEntry) => void;
}

function HighlightedWord({ matched, entry, onPick }: HighlightedWordProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const markRef = useRef<HTMLElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  function compute(): Pos | null {
    const rect = markRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const wantLeft = rect.left + rect.width / 2 - POP_W / 2;
    const left = Math.max(
      VIEWPORT_M,
      Math.min(window.innerWidth - POP_W - VIEWPORT_M, wantLeft),
    );
    const flipUp = rect.bottom + POP_H_EST + 6 > window.innerHeight;
    const top = flipUp
      ? Math.max(VIEWPORT_M, rect.top - POP_H_EST - 6)
      : rect.bottom + 6;
    return { top, left };
  }

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      const t = e.target as Node;
      if (markRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onScroll() {
      // 父容器一滚位置就错了,直接关掉,简单可靠
      setOpen(false);
    }
    function onResize() {
      const p = compute();
      if (p) setPos(p);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  return (
    <>
      <mark
        ref={markRef}
        className="bg-amber-100 hover:bg-amber-200 rounded px-0.5 cursor-pointer transition-colors text-stone-900"
        onClick={(e) => {
          if (!entry) return;
          e.stopPropagation();
          if (onPick) onPick(entry);
          if (!open) {
            const p = compute();
            if (p) setPos(p);
          }
          setOpen((v) => !v);
        }}
      >
        {matched}
      </mark>
      {open && entry && pos &&
        createPortal(
          <div
            ref={popoverRef}
            role="tooltip"
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              width: POP_W,
            }}
            className="z-50 max-h-[70vh] overflow-y-auto bg-white border border-stone-200 shadow-xl rounded-lg p-4 text-left cursor-default normal-case"
          >
            <div className="text-lg font-medium text-stone-900">{entry.word}</div>
            <div className="mt-1 text-sm text-stone-500">
              {entry.lemma &&
                entry.lemma.toLowerCase() !== entry.word.toLowerCase() && (
                  <span className="mr-2">({entry.lemma})</span>
                )}
              {entry.phonetic && (
                <span className="font-mono mr-2">{entry.phonetic}</span>
              )}
              {entry.pos && <span className="italic">{entry.pos}</span>}
            </div>
            <div className="mt-3 text-base text-stone-800 leading-relaxed">
              {entry.definition_zh}
            </div>
            {entry.definition_en && (
              <div className="mt-1.5 text-sm text-stone-500 leading-relaxed">
                {entry.definition_en}
              </div>
            )}
            {entry.example_zh && (
              <div className="mt-3 text-sm text-stone-500 italic leading-relaxed">
                {entry.example_zh}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

export function highlightText(
  text: string,
  vocab: VocabEntry[],
  onClick?: (entry: VocabEntry) => void,
): ReactNode[] {
  if (vocab.length === 0) return [text];
  const sorted = [...vocab].sort((a, b) => b.word.length - a.word.length);
  const map = new Map<string, VocabEntry>();
  for (const v of sorted) {
    if (!map.has(v.word.toLowerCase())) {
      map.set(v.word.toLowerCase(), v);
    }
  }
  const escaped = sorted.map((v) => v.word.replace(ESCAPE_RE, '\\$&'));
  let re: RegExp;
  try {
    re = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
  } catch {
    return [text];
  }
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const matched = m[0];
    const entry = map.get(matched.toLowerCase());
    parts.push(
      <HighlightedWord
        key={`${m.index}-${matched}`}
        matched={matched}
        entry={entry}
        onPick={onClick}
      />,
    );
    last = m.index + matched.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
