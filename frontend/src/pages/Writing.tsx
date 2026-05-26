import { useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles, Copy, Check, Trash2 } from 'lucide-react';
import {
  deleteWritingDraft,
  listWritingHistory,
  polishWriting,
} from '../api';
import type { PolishResult } from '../types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import ProviderBadge from '../components/ProviderBadge';
import { cn } from '@/lib/utils';

const DRAFT_STORAGE_KEY = 'writing-draft-text';
const TRANSLATE_STORAGE_KEY = 'writing-translate-enabled';

export default function Writing() {
  const [text, setText] = useState(() => localStorage.getItem(DRAFT_STORAGE_KEY) ?? '');
  const [translateEnabled, setTranslateEnabled] = useState<boolean>(() => {
    const stored = localStorage.getItem(TRANSLATE_STORAGE_KEY);
    return stored == null ? true : stored === '1';
  });
  const [result, setResult] = useState<PolishResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<PolishResult[]>([]);
  const [historyOpen, setHistoryOpen] = useState<Set<number>>(new Set());

  // Persist draft + setting locally so a tab reload doesn't lose work.
  useEffect(() => {
    localStorage.setItem(DRAFT_STORAGE_KEY, text);
  }, [text]);
  useEffect(() => {
    localStorage.setItem(TRANSLATE_STORAGE_KEY, translateEnabled ? '1' : '0');
  }, [translateEnabled]);

  useEffect(() => {
    refreshHistory();
  }, []);

  async function refreshHistory() {
    try {
      setHistory(await listWritingHistory());
    } catch (e) {
      // Don't surface — history is secondary, the editor still works.
      console.warn('failed to load writing history', e);
    }
  }

  async function onSubmit() {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const out = await polishWriting({
        text: trimmed,
        translate_enabled: translateEnabled,
      });
      setResult(out);
      if (out.action !== 'skip') {
        refreshHistory();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Cmd/Ctrl + Enter inside the textarea submits.
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      onSubmit();
    }
  }

  async function onDelete(id: number) {
    if (!confirm('删除这条记录?')) return;
    await deleteWritingDraft(id);
    setHistory((prev) => prev.filter((h) => h.id !== id));
  }

  function toggleHistory(id: number) {
    setHistoryOpen((prev) => {
      const copy = new Set(prev);
      if (copy.has(id)) copy.delete(id);
      else copy.add(id);
      return copy;
    });
  }

  const charCount = useMemo(() => text.trim().length, [text]);

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-6 py-10">
        <div className="mb-6 flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-medium tracking-tight text-foreground">
              写作练习
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              写一段英文,AI 帮你挑出问题并改写成 native 版本。中文输入会自动翻成地道英文。
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={translateEnabled}
              onChange={(e) => setTranslateEnabled(e.target.checked)}
              className="accent-primary"
            />
            中译英开
          </label>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-3">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="在这里写你的英文(或中文,会翻成英文)... &#10;&#10;⌘↵ / Ctrl+↵ 提交"
              className="min-h-[320px] resize-y font-mono text-sm leading-7"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {charCount} 字符
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setText('');
                    setResult(null);
                    setError(null);
                  }}
                  disabled={!text && !result}
                >
                  清空
                </Button>
                <Button
                  onClick={onSubmit}
                  disabled={!charCount || loading}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {loading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  {loading ? '润色中...' : '润色 (⌘↵)'}
                </Button>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4 min-h-[320px]">
            <ResultPanel result={result} loading={loading} error={error} />
          </div>
        </div>

        <section className="mt-12">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-lg font-medium text-foreground">历史记录</h2>
            <span className="text-xs text-muted-foreground">
              {history.length} 条
            </span>
          </div>
          {history.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
              还没有润色记录。试着写一句英文吧。
            </div>
          ) : (
            <ul className="space-y-2">
              {history.map((h) => {
                const open = h.id != null && historyOpen.has(h.id);
                return (
                  <li
                    key={h.id ?? Math.random()}
                    className="rounded-lg border border-border bg-card p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => h.id != null && toggleHistory(h.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="rounded bg-accent px-1.5 py-0.5 text-foreground/70">
                            {h.action === 'translate' ? '中→英' : '润色'}
                          </span>
                          <span>
                            {h.created_at
                              ? new Date(h.created_at).toLocaleString()
                              : ''}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm leading-6 text-foreground">
                          {h.original}
                        </p>
                      </button>
                      {h.id != null && (
                        <button
                          type="button"
                          onClick={() => onDelete(h.id!)}
                          className="text-xs text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </div>
                    {open && (
                      <div className="mt-3 border-t border-border pt-3">
                        <ResultPanel result={h} loading={false} error={null} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function ResultPanel({
  result,
  loading,
  error,
}: {
  result: PolishResult | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        正在分析...
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!result) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        在左边输入,点"润色"开始
      </div>
    );
  }
  if (result.action === 'skip') {
    return (
      <div className="text-sm text-muted-foreground">
        <div className="mb-2 font-medium text-foreground">已跳过</div>
        {result.skip_reason ?? '输入内容不足以分析'}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-primary" />
        <span className="text-sm font-medium text-foreground">
          {result.action === 'translate' ? '英文版' : '英文润色'}
        </span>
        {result.provider && <ProviderBadge provider={result.provider} />}
      </div>

      {result.action === 'polish' && (
        <>
          {result.tips && result.tips.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                ✏️ Tips
              </div>
              <ul className="space-y-2">
                {result.tips.map((tip, i) => (
                  <li key={i} className="rounded-md bg-accent/40 p-2.5 text-sm">
                    <div className="flex flex-wrap items-baseline gap-1.5">
                      <span className="text-destructive line-through">
                        {tip.original}
                      </span>
                      <span className="text-muted-foreground">→</span>
                      <span className="font-medium text-foreground">
                        {tip.corrected}
                      </span>
                    </div>
                    <div className="mt-1 text-xs leading-5 text-muted-foreground">
                      {tip.explanation_zh}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.tips && result.tips.length === 0 && (
            <div className="text-xs text-muted-foreground">
              ✏️ 没挑出问题,英文已经写得不错
            </div>
          )}
          {result.rewrite && (
            <CopyableBlock label="✍️ Native rewrite" text={result.rewrite} />
          )}
        </>
      )}

      {result.action === 'translate' && result.translation && (
        <CopyableBlock label="🌐 English" text={result.translation} />
      )}
    </div>
  );
}

function CopyableBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <button
          type="button"
          onClick={onCopy}
          className={cn(
            'inline-flex items-center gap-1 text-xs',
            copied ? 'text-emerald-600' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <div className="rounded-md border border-border bg-background p-3 text-sm leading-7 text-foreground whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}
