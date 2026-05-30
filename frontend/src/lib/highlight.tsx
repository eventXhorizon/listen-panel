import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Trash2 } from 'lucide-react';
import type { MaterialLanguage, VocabEntry } from '../types';
import SpeakButton from '../components/SpeakButton';
import { deleteVocab } from '../api';
import { languageAdapter } from './languages';

const POP_W_DESKTOP = 352;  // w-[22rem]
const POP_H_EST = 320;       // 估值,用于决定上下翻转
const VIEWPORT_M = 12;       // 视口边距

/**
 * iOS Safari pushes the keyboard up over the layout viewport but leaves
 * `window.innerHeight` unchanged. visualViewport reflects what the user can
 * actually see; fall back to the layout viewport on browsers that don't
 * expose it.
 */
function viewportSize(): { width: number; height: number; offsetTop: number } {
  const vv = window.visualViewport;
  if (vv) return { width: vv.width, height: vv.height, offsetTop: vv.offsetTop };
  return { width: window.innerWidth, height: window.innerHeight, offsetTop: 0 };
}

interface Pos {
  top: number;
  left: number;
  width: number;
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
    const { width: vw, height: vh, offsetTop } = viewportSize();
    // On iPhone SE (375px) the 352px desktop popover leaves only 12px of side
    // margin combined. Cap width to viewport minus 2× margin so it always fits.
    const width = Math.min(POP_W_DESKTOP, vw - VIEWPORT_M * 2);
    const wantLeft = rect.left + rect.width / 2 - width / 2;
    const left = Math.max(
      VIEWPORT_M,
      Math.min(vw - width - VIEWPORT_M, wantLeft),
    );
    // Flip decision uses the visible viewport (visualViewport.height shrinks
    // when the iOS keyboard appears); offsetTop accounts for the keyboard
    // pushing the visual viewport down.
    const visibleBottom = offsetTop + vh;
    const flipUp = rect.bottom + POP_H_EST + 6 > visibleBottom;
    const top = flipUp
      ? Math.max(offsetTop + VIEWPORT_M, rect.top - POP_H_EST - 6)
      : rect.bottom + 6;
    return { top, left, width };
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
    // visualViewport fires when the iOS keyboard appears/disappears or the
    // page is pinch-zoomed. Reposition (don't close) so the popover stays
    // anchored to its mark while the visible viewport shifts.
    const vv = window.visualViewport;
    vv?.addEventListener('resize', onResize);
    vv?.addEventListener('scroll', onResize);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      vv?.removeEventListener('resize', onResize);
      vv?.removeEventListener('scroll', onResize);
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
              width: pos.width,
            }}
            // max-h uses dvh (dynamic viewport) so the popover stays usable
            // when the iOS keyboard pushes the layout up. 70vh would compute
            // against the full layout viewport and overflow off-screen.
            className="z-50 max-h-[70dvh] overflow-y-auto bg-card border border-border shadow-xl rounded-lg p-4 text-left cursor-default normal-case"
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
