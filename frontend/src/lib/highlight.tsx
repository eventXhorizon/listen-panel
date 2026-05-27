import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Trash2 } from 'lucide-react';
import type { MaterialLanguage, VocabEntry } from '../types';
import SpeakButton from '../components/SpeakButton';
import { deleteVocab } from '../api';
import { languageAdapter } from './languages';

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
  materialId?: number;
  language: MaterialLanguage;
  onPick?: (entry: VocabEntry) => void;
  /** Called after the user clicks 删除 inside the popover and the
   *  backend DELETE succeeds. Parent should refresh its vocab list so
   *  the highlight disappears. */
  onDeleted?: (entry: VocabEntry) => void;
}

function HighlightedWord({
  matched,
  entry,
  materialId,
  language,
  onPick,
  onDeleted,
}: HighlightedWordProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const markRef = useRef<HTMLElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  function compute(): Pos | null {
    const rect = elementRect(markRef.current);
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

  function toggle(e: React.MouseEvent | React.PointerEvent | React.TouchEvent) {
    if (!entry) return;
    if (hasActiveTextSelection()) return;
    e.stopPropagation();
    if (onPick) onPick(entry);
    if (!open) {
      const p = compute();
      if (p) setPos(p);
    }
    setOpen((v) => !v);
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

  const isIdiom = entry?.kind === 'idiom';
  return (
    <>
      <mark
        ref={markRef}
        className={
          isIdiom
            ? 'bg-primary/10 hover:bg-primary/20 rounded px-0.5 cursor-pointer transition-colors text-foreground underline decoration-dotted decoration-primary/60 underline-offset-[3px]'
            : 'bg-primary/15 hover:bg-primary/25 rounded px-0.5 cursor-pointer transition-colors text-foreground'
        }
        onPointerUp={(e) => {
          if (e.pointerType === 'touch') toggle(e);
        }}
        onClick={toggle}
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
            className="z-50 max-h-[70vh] overflow-y-auto bg-card border border-border shadow-xl rounded-lg p-4 text-left cursor-default normal-case"
          >
            <div className="flex items-center gap-2">
              <div className="text-lg font-medium text-foreground">{entry.word}</div>
              <SpeakButton word={entry.word} materialId={materialId} language={language} />
              <button
                type="button"
                disabled={deleting}
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!confirm(`从生词本删除「${entry.word}」?`)) return;
                  setDeleting(true);
                  setDeleteError(null);
                  try {
                    await deleteVocab(entry.id);
                    setOpen(false);
                    onDeleted?.(entry);
                  } catch (err) {
                    setDeleteError((err as Error).message);
                  } finally {
                    setDeleting(false);
                  }
                }}
                className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                title="从生词本删除"
                aria-label="从生词本删除"
              >
                {deleting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
              </button>
            </div>
            {deleteError && (
              <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
                删除失败:{deleteError}
              </div>
            )}
            <div className="mt-1 text-sm text-muted-foreground">
              {entry.lemma &&
                entry.lemma.toLowerCase() !== entry.word.toLowerCase() && (
                  <span className="mr-2">({entry.lemma})</span>
                )}
              {entry.phonetic && (
                <span className="font-mono mr-2">{entry.phonetic}</span>
              )}
              {entry.pos && <span className="italic">{entry.pos}</span>}
            </div>
            <div className="mt-3 text-base text-foreground leading-relaxed">
              {entry.definition_zh}
            </div>
            {entry.definition_en && (
              <div className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
                {entry.definition_en}
              </div>
            )}
            {entry.example_zh && (
              <div className="mt-3 text-sm text-muted-foreground italic leading-relaxed">
                {entry.example_zh}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function elementRect(el: Element | null): DOMRect | DOMRectReadOnly | null {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (isUsableRect(rect)) return rect;
  for (const item of Array.from(el.getClientRects())) {
    if (isUsableRect(item)) return item;
  }
  return null;
}

function isUsableRect(rect: DOMRect | DOMRectReadOnly): boolean {
  return (
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.left) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function hasActiveTextSelection(): boolean {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

export function highlightText(
  text: string,
  vocab: VocabEntry[],
  materialId?: number,
  language: MaterialLanguage = 'en',
  onClick?: (entry: VocabEntry) => void,
  onDeleted?: (entry: VocabEntry) => void,
): ReactNode[] {
  if (vocab.length === 0) return [text];
  const matches = languageAdapter(language).highlightText(
    text,
    vocab.filter((entry) => entry.language === language),
  );
  if (matches.length === 0) return [text];

  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of matches) {
    if (match.start < last) continue;
    if (match.start > last) parts.push(text.slice(last, match.start));
    const matched = text.slice(match.start, match.end);
    const entry = match.entry;
    parts.push(
      <HighlightedWord
        key={`${match.start}-${matched}`}
        matched={matched}
        entry={entry}
        materialId={materialId}
        language={language}
        onPick={onClick}
        onDeleted={onDeleted}
      />,
    );
    last = match.end;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
