import { useEffect, useState, type RefObject } from 'react';
import type { MaterialLanguage } from '../types';
import SpeakButton from './SpeakButton';

interface Sel {
  text: string;
  rect: DOMRect;
}

interface Props {
  containerRef: RefObject<HTMLElement | null>;
  materialId?: number;
  language?: MaterialLanguage;
  onAdd: (text: string) => void;
}

export default function SelectionPopup({
  containerRef,
  materialId,
  language = 'en',
  onAdd,
}: Props) {
  const [sel, setSel] = useState<Sel | null>(null);

  useEffect(() => {
    let timer = 0;

    function readSelection() {
      const s = window.getSelection();
      if (!s || s.isCollapsed || s.rangeCount === 0) {
        setSel(null);
        return;
      }
      const text = s.toString().trim();
      if (!text || text.length > 80) {
        setSel(null);
        return;
      }
      const range = s.getRangeAt(0);
      const container = containerRef.current;
      if (!container || !container.contains(range.commonAncestorContainer)) {
        setSel(null);
        return;
      }
      const rect = selectionRect(range);
      if (!rect) {
        setSel(null);
        return;
      }
      setSel({ text, rect });
    }

    function scheduleRead(target: EventTarget | null, delay = 40) {
      if ((target as HTMLElement | null)?.closest?.('.selection-popup')) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(readSelection, delay);
    }

    function onSelectionChange() {
      scheduleRead(document.activeElement, 80);
    }

    function onPointerUp(e: PointerEvent) {
      scheduleRead(e.target, e.pointerType === 'touch' ? 120 : 20);
    }

    function onTouchEnd(e: TouchEvent) {
      scheduleRead(e.target, 140);
    }

    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('touchend', onTouchEnd);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [containerRef]);

  if (!sel) return null;
  const top = Math.min(window.innerHeight - 44, sel.rect.bottom + 6);
  const left = Math.max(12, Math.min(window.innerWidth - 12, sel.rect.left + sel.rect.width / 2));

  return (
    <div
      className="selection-popup fixed z-50 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-lg border border-border bg-card p-1.5 shadow-lg shadow-foreground/10"
      style={{ top, left }}
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.preventDefault()}
      onTouchStart={(e) => e.preventDefault()}
    >
      <SpeakButton
        word={sel.text}
        materialId={materialId}
        language={language}
        className="h-7 w-7"
      />
      <button
        type="button"
        onClick={() => {
          onAdd(sel.text);
          setSel(null);
          window.getSelection()?.removeAllRanges();
        }}
        className="h-7 whitespace-nowrap rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
      >
        + 加为生词
      </button>
    </div>
  );
}

function selectionRect(range: Range): DOMRect | null {
  const rect = range.getBoundingClientRect();
  if (isUsableRect(rect)) return rect;
  for (const item of Array.from(range.getClientRects())) {
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
