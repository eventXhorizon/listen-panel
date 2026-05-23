import { useState } from 'react';
import { Link } from 'react-router-dom';
import { createQuickNote } from '../api';
import type { MaterialLanguage, QuickNote } from '../types';
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

          {result && <ResultView note={result} />}
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

export function ResultView({ note }: { note: QuickNote }) {
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
    </div>
  );
}
