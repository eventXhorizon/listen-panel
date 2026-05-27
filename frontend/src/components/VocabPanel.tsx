import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import type { VocabEntry, VocabKind } from '../types';
import { deleteVocab } from '../api';
import SpeakButton from './SpeakButton';
import { cn } from '@/lib/utils';

interface Props {
  items: VocabEntry[];
  onClose: () => void;
  onChange: () => void;
}

const TABS: { value: VocabKind; label: string }[] = [
  { value: 'word', label: '生词' },
  { value: 'idiom', label: '地道表达' },
];

export default function VocabPanel({ items, onClose, onChange }: Props) {
  const counts = useMemo(() => {
    const c: Record<VocabKind, number> = { word: 0, idiom: 0 };
    for (const v of items) {
      c[v.kind ?? 'word'] += 1;
    }
    return c;
  }, [items]);
  const initialTab: VocabKind = counts.word === 0 && counts.idiom > 0 ? 'idiom' : 'word';
  const [tab, setTab] = useState<VocabKind>(initialTab);

  const visible = items.filter((v) => (v.kind ?? 'word') === tab);

  async function onDelete(id: number) {
    if (!confirm('确定删除?')) return;
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
          <div className="flex items-center gap-1">
            {TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setTab(t.value)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition',
                  tab === t.value
                    ? 'bg-accent font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {counts[t.value]}
                </span>
              </button>
            ))}
          </div>
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
          {visible.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {tab === 'word'
                ? '本篇还没收录生词。在原文里选中一段文字试试。'
                : '本篇暂无地道表达。导入新闻时会自动抽取 8 个。'}
            </p>
          )}
          <ul className="space-y-3">
            {visible.map((v) => (
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
                      materialId={v.material_id ?? undefined}
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
                {v.example_zh && (
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {v.example_zh}
                  </p>
                )}
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
