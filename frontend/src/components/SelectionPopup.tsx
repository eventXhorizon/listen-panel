import { useEffect, useState, type RefObject } from 'react';

interface Sel {
  text: string;
  rect: DOMRect;
}

interface Props {
  containerRef: RefObject<HTMLElement | null>;
  onAdd: (text: string) => void;
}

export default function SelectionPopup({ containerRef, onAdd }: Props) {
  const [sel, setSel] = useState<Sel | null>(null);

  useEffect(() => {
    function onMouseUp(e: MouseEvent) {
      if ((e.target as HTMLElement).closest('.selection-popup')) return;
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
      setSel({ text, rect: range.getBoundingClientRect() });
    }
    document.addEventListener('mouseup', onMouseUp);
    return () => document.removeEventListener('mouseup', onMouseUp);
  }, [containerRef]);

  if (!sel) return null;
  const top = sel.rect.bottom + 6;
  const left = sel.rect.left + sel.rect.width / 2;

  return (
    <div
      className="selection-popup fixed z-50 -translate-x-1/2"
      style={{ top, left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        onClick={() => {
          onAdd(sel.text);
          setSel(null);
          window.getSelection()?.removeAllRanges();
        }}
        className="px-3 py-1.5 rounded-md bg-stone-900 text-white text-xs shadow-lg hover:bg-stone-700 whitespace-nowrap"
      >
        + 加为生词
      </button>
    </div>
  );
}
