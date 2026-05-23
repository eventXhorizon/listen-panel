import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { deleteQuickNote, listQuickNotes } from '../api';
import type { QuickNote } from '../types';
import { Button } from '@/components/ui/button';
import QuickNoteDialog, { ResultView } from '../components/QuickNoteDialog';

export default function QuickNotes() {
  const [items, setItems] = useState<QuickNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [language, setLanguage] = useState<'all' | 'en' | 'ja'>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setItems(await listQuickNotes());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return items.filter((note) => {
      if (language !== 'all' && note.language !== language) return false;
      if (!ql) return true;
      return (
        note.text.toLowerCase().includes(ql) ||
        note.translation_zh.toLowerCase().includes(ql) ||
        note.highlights.some((h) =>
          h.phrase.toLowerCase().includes(ql) || h.meaning_zh.includes(q),
        )
      );
    });
  }, [items, language, q]);

  async function onDelete(id: number) {
    if (!confirm('确定删除这条随手记?')) return;
    await deleteQuickNote(id);
    setItems((next) => next.filter((item) => item.id !== id));
    setExpanded((next) => {
      const copy = new Set(next);
      copy.delete(id);
      return copy;
    });
  }

  function toggleExpand(id: number) {
    setExpanded((next) => {
      const copy = new Set(next);
      if (copy.has(id)) copy.delete(id);
      else copy.add(id);
      return copy;
    });
  }

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-10">
        <div className="mb-6 flex items-baseline justify-between">
          <h1 className="text-2xl font-medium tracking-tight text-foreground">
            随手记
          </h1>
          <span className="text-sm text-muted-foreground">
            {filtered.length} / {items.length}
          </span>
        </div>

        <div className="mb-6 flex flex-wrap gap-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索原文、翻译、地道表达..."
            className="min-w-[220px] flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:border-border"
          />
          <select
            value={language}
            onChange={(e) =>
              setLanguage(e.target.value as 'all' | 'en' | 'ja')
            }
            className="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:border-border"
          >
            <option value="all">全部语言</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
          </select>
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="size-4" />
            记一条
          </Button>
        </div>

        {loading && <p className="text-sm text-muted-foreground">加载中...</p>}

        {error && (
          <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center">
            <p className="text-muted-foreground">
              {items.length === 0
                ? '还没有随手记。点右上角「记一条」开始记录在其他地方看到的句子。'
                : '没有匹配的记录'}
            </p>
          </div>
        )}

        <ul className="space-y-3">
          {filtered.map((note) => {
            const isOpen = expanded.has(note.id);
            return (
              <li
                key={note.id}
                className="rounded-lg border border-border bg-card p-4"
              >
                <div className="mb-2 flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <p
                      className="cursor-pointer text-sm leading-7 text-foreground"
                      onClick={() => toggleExpand(note.id)}
                    >
                      {note.text}
                    </p>
                    <p className="mt-1 text-xs leading-6 text-muted-foreground">
                      {note.translation_zh}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
                      <span className="rounded bg-accent px-1.5 py-0.5 text-foreground/70">
                        {note.language === 'ja' ? '日' : 'EN'}
                      </span>
                      <span>{new Date(note.created_at).toLocaleString()}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => toggleExpand(note.id)}
                        className="text-xs text-muted-foreground/70 hover:text-foreground"
                      >
                        {isOpen ? '收起' : '展开'}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(note.id)}
                        className="text-xs text-muted-foreground/70 hover:text-destructive"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </div>
                {isOpen && (
                  <div className="mt-3 border-t border-border pt-3">
                    <ResultView
                      note={note}
                      onUpdated={(updated) =>
                        setItems((next) =>
                          next.map((n) => (n.id === updated.id ? updated : n)),
                        )
                      }
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {dialogOpen && (
        <QuickNoteDialog
          onClose={() => setDialogOpen(false)}
          onSaved={(note) => setItems((next) => [note, ...next])}
        />
      )}
    </main>
  );
}
