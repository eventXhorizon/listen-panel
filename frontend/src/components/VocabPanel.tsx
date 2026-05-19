import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import type { VocabEntry } from '../types';
import { deleteVocab } from '../api';
import SpeakButton from './SpeakButton';

interface Props {
  items: VocabEntry[];
  onClose: () => void;
  onChange: () => void;
}

export default function VocabPanel({ items, onClose, onChange }: Props) {
  async function onDelete(id: number) {
    if (!confirm('确定删除这条生词?')) return;
    await deleteVocab(id);
    onChange();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl bg-card shadow-2xl shadow-foreground/20"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-base font-medium text-foreground">
            本篇生词 ({items.length})
          </h2>
          <div className="flex items-center gap-3">
            <Link
              to="/vocab"
              onClick={onClose}
              className="text-xs text-muted-foreground transition hover:text-foreground"
            >
              查看全部 →
            </Link>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {items.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              还没有生词。在原文里选中一段文字试试。
            </p>
          )}
          <ul className="space-y-3">
            {items.map((v) => (
              <li
                key={v.id}
                className="group rounded-lg border border-border bg-background/50 p-3 transition hover:border-primary/30"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-2">
                    <span className="text-base font-medium text-foreground">
                      {v.word}
                    </span>
                    <SpeakButton
                      word={v.word}
                      materialId={v.material_id}
                      language={v.language}
                    />
                    {v.lemma &&
                      v.lemma.toLowerCase() !== v.word.toLowerCase() && (
                        <span className="text-xs text-muted-foreground/70">
                          ({v.lemma})
                        </span>
                      )}
                    {v.phonetic && (
                      <span className="font-mono text-xs text-muted-foreground">
                        {v.phonetic}
                      </span>
                    )}
                    {v.pos && (
                      <span className="text-xs italic text-muted-foreground">
                        {v.pos}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onDelete(v.id)}
                    className="text-xs text-muted-foreground/70 opacity-0 transition hover:text-destructive group-hover:opacity-100"
                  >
                    删除
                  </button>
                </div>
                <p className="mt-1 text-sm leading-relaxed text-foreground/85">
                  {v.definition_zh}
                </p>
                {v.context && (
                  <p className="mt-1.5 line-clamp-2 text-xs italic text-muted-foreground">
                    “{v.context}”
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
