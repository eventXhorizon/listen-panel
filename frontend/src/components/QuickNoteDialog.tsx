import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Plus, X } from 'lucide-react';
import { createQuickNote, updateQuickNote } from '../api';
import type {
  MaterialLanguage,
  QuickNote,
  QuickNoteGrammar,
  QuickNoteHighlight,
} from '../types';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

const LAST_LANG_KEY = 'listen-panel:quick-note:last-language';

function loadLastLanguage(): MaterialLanguage {
  if (typeof window === 'undefined') return 'en';
  const v = window.localStorage.getItem(LAST_LANG_KEY);
  return v === 'ja' ? 'ja' : 'en';
}

interface Props {
  onClose: () => void;
  /** Called after a successful save, e.g. so the history page can refresh. */
  onSaved?: (note: QuickNote) => void;
}

export default function QuickNoteDialog({ onClose, onSaved }: Props) {
  const [text, setText] = useState('');
  const [language, setLanguage] = useState<MaterialLanguage>(loadLastLanguage);
  const [source, setSource] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QuickNote | null>(null);

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed) {
      setError('请输入要记录的句子');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      window.localStorage.setItem(LAST_LANG_KEY, language);
      const note = await createQuickNote({
        text: trimmed,
        language,
        source: source.trim() || undefined,
      });
      setResult(note);
      onSaved?.(note);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setText('');
    setSource('');
    setResult(null);
    setError(null);
  }

  const keyMissing = (error ?? '').toLowerCase().includes('not configured');

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="text-base font-medium">随手记</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto px-6 py-5">
          {!result && (
            <>
              <label className="block">
                <div className="mb-1 text-xs text-muted-foreground">
                  句子(粘贴在其他地方看到的句子)
                </div>
                <Textarea
                  autoFocus
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={12}
                  placeholder="例如:I've been meaning to call her all week."
                  className="resize-y px-3 py-2 text-sm leading-relaxed min-h-[280px]"
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <div className="mb-1 text-xs text-muted-foreground">语言</div>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value as MaterialLanguage)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="en">English</option>
                    <option value="ja">日本語</option>
                  </select>
                </label>
                <label className="block">
                  <div className="mb-1 text-xs text-muted-foreground">
                    出处(可选,URL 或备注)
                  </div>
                  <Input
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    placeholder="https://... 或 听某个播客"
                    className="h-9 px-3 text-sm"
                  />
                </label>
              </div>

              {error && (
                <div className="rounded border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  <div>{error}</div>
                  {keyMissing && (
                    <Link
                      to="/settings"
                      onClick={onClose}
                      className="mt-1 inline-block underline"
                    >
                      去设置 →
                    </Link>
                  )}
                </div>
              )}
            </>
          )}

          {result && (
            <ResultView note={result} onUpdated={setResult} />
          )}
        </div>

        <DialogFooter className="border-t border-border px-6 py-3">
          {!result ? (
            <>
              <Button variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button onClick={submit} disabled={submitting || !text.trim()}>
                {submitting ? 'DeepSeek 分析中...' : '分析并保存'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={reset}>
                再记一条
              </Button>
              <Button onClick={onClose}>关闭</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ResultViewProps {
  note: QuickNote;
  /** When provided, the view can be toggled into edit mode and changes are
   *  persisted via PATCH. Omit for read-only rendering. */
  onUpdated?: (updated: QuickNote) => void;
}

export function ResultView({ note, onUpdated }: ResultViewProps) {
  const [editing, setEditing] = useState(false);

  // Whenever the underlying note changes, exit edit mode (e.g., user
  // switched between expanded items on the history page).
  useEffect(() => {
    setEditing(false);
  }, [note.id]);

  if (editing && onUpdated) {
    return (
      <EditView
        note={note}
        onCancel={() => setEditing(false)}
        onSaved={(updated) => {
          onUpdated(updated);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 text-xs text-muted-foreground">原文</div>
        <p className="text-base leading-relaxed text-foreground">{note.text}</p>
      </div>
      <div>
        <div className="mb-1 text-xs text-muted-foreground">中文翻译</div>
        <p className="text-sm leading-relaxed text-foreground">
          {note.translation_zh}
        </p>
      </div>
      {note.highlights.length > 0 && (
        <div>
          <div className="mb-2 text-xs text-muted-foreground">重点表达</div>
          <ul className="space-y-2">
            {note.highlights.map((h, i) => (
              <li
                key={i}
                className="rounded-md border border-border bg-accent/40 px-3 py-2 text-sm"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium text-foreground">{h.phrase}</span>
                  <span className="text-muted-foreground">{h.meaning_zh}</span>
                </div>
                {h.usage_note && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {h.usage_note}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {note.grammar.length > 0 && (
        <div>
          <div className="mb-2 text-xs text-muted-foreground">语法</div>
          <ul className="space-y-2">
            {note.grammar.map((g, i) => (
              <li
                key={i}
                className="rounded-md border border-border bg-accent/40 px-3 py-2 text-sm"
              >
                <div className="font-medium text-foreground">{g.point}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {g.explanation_zh}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {note.source && (
        <div>
          <div className="mb-1 text-xs text-muted-foreground">出处</div>
          <div className="break-all text-xs text-muted-foreground">
            {/^https?:\/\//.test(note.source) ? (
              <a
                href={note.source}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {note.source}
              </a>
            ) : (
              note.source
            )}
          </div>
        </div>
      )}
      {onUpdated && (
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Pencil className="size-3" />
            编辑
          </button>
        </div>
      )}
    </div>
  );
}

function EditView({
  note,
  onCancel,
  onSaved,
}: {
  note: QuickNote;
  onCancel: () => void;
  onSaved: (updated: QuickNote) => void;
}) {
  const [translation, setTranslation] = useState(note.translation_zh);
  const [highlights, setHighlights] = useState<QuickNoteHighlight[]>(
    note.highlights,
  );
  const [grammar, setGrammar] = useState<QuickNoteGrammar[]>(note.grammar);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateQuickNote(note.id, {
        translation_zh: translation.trim(),
        highlights,
        grammar,
      });
      onSaved(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function patchHighlight(i: number, patch: Partial<QuickNoteHighlight>) {
    setHighlights((arr) =>
      arr.map((h, j) => (j === i ? { ...h, ...patch } : h)),
    );
  }
  function patchGrammar(i: number, patch: Partial<QuickNoteGrammar>) {
    setGrammar((arr) => arr.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 text-xs text-muted-foreground">原文(只读)</div>
        <p className="text-base leading-relaxed text-foreground">{note.text}</p>
      </div>

      <label className="block">
        <div className="mb-1 text-xs text-muted-foreground">中文翻译</div>
        <textarea
          value={translation}
          onChange={(e) => setTranslation(e.target.value)}
          rows={3}
          className="block w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </label>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">重点表达</span>
          <button
            type="button"
            onClick={() =>
              setHighlights((arr) => [
                ...arr,
                { phrase: '', meaning_zh: '', usage_note: undefined },
              ])
            }
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-3" />
            添加
          </button>
        </div>
        <ul className="space-y-2">
          {highlights.map((h, i) => (
            <li
              key={i}
              className="rounded-md border border-border bg-card px-3 py-2.5"
            >
              <div className="mb-1 flex items-center justify-end">
                <button
                  type="button"
                  onClick={() =>
                    setHighlights((arr) => arr.filter((_, j) => j !== i))
                  }
                  aria-label="删除"
                  className="rounded p-0.5 text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <input
                value={h.phrase}
                onChange={(e) => patchHighlight(i, { phrase: e.target.value })}
                placeholder="原文短语 / 表达"
                className="mb-2 block w-full rounded border border-input bg-background px-2 py-1 text-sm font-medium focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <input
                value={h.meaning_zh}
                onChange={(e) =>
                  patchHighlight(i, { meaning_zh: e.target.value })
                }
                placeholder="中文含义"
                className="mb-2 block w-full rounded border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <textarea
                value={h.usage_note ?? ''}
                onChange={(e) =>
                  patchHighlight(i, {
                    usage_note: e.target.value || undefined,
                  })
                }
                placeholder="(可选)用法说明 / 易混淆"
                rows={2}
                className="block w-full resize-y rounded border border-input bg-background px-2 py-1 text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </li>
          ))}
        </ul>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">语法</span>
          <button
            type="button"
            onClick={() =>
              setGrammar((arr) => [...arr, { point: '', explanation_zh: '' }])
            }
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-3" />
            添加
          </button>
        </div>
        <ul className="space-y-2">
          {grammar.map((g, i) => (
            <li
              key={i}
              className="rounded-md border border-border bg-card px-3 py-2.5"
            >
              <div className="mb-1 flex items-center justify-end">
                <button
                  type="button"
                  onClick={() =>
                    setGrammar((arr) => arr.filter((_, j) => j !== i))
                  }
                  aria-label="删除"
                  className="rounded p-0.5 text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <input
                value={g.point}
                onChange={(e) => patchGrammar(i, { point: e.target.value })}
                placeholder="语法点名称(如「定语从句」)"
                className="mb-2 block w-full rounded border border-input bg-background px-2 py-1 text-sm font-medium focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <textarea
                value={g.explanation_zh}
                onChange={(e) =>
                  patchGrammar(i, { explanation_zh: e.target.value })
                }
                placeholder="中文说明"
                rows={2}
                className="block w-full resize-y rounded border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </li>
          ))}
        </ul>
      </div>

      {error && (
        <div className="rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          取消
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  );
}
