import { useEffect, useMemo, useRef, useState } from 'react';
import { Radio, RefreshCw, Search } from 'lucide-react';
import type { LogEntry } from '../types';
import { useAuth } from '../lib/auth-context';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const LEVELS = ['ALL', 'ERROR', 'WARN', 'INFO'] as const;
type LevelFilter = (typeof LEVELS)[number];

const LEVEL_STYLE: Record<string, string> = {
  ERROR: 'border-destructive/30 bg-destructive/10 text-destructive',
  WARN: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
  INFO: 'border-border bg-accent text-muted-foreground',
};

/// Cap what we hold in the DOM. The server ring is 2000 lines; matching it
/// keeps a long-lived stream from growing the page without bound.
const MAX_ENTRIES = 2000;

type ConnState = 'connecting' | 'live' | 'paused' | 'error';

const CONN_LABEL: Record<ConnState, string> = {
  connecting: '连接中…',
  live: '实时',
  paused: '已暂停',
  error: '连接断开,重试中…',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString('zh-CN', { hour12: false });
}

/// Live tail of the server log over SSE. The backend keeps the last ~2000
/// INFO+ lines in memory and pushes each new one as it happens, so this shows
/// what the server is doing without reaching for `docker logs`.
export default function Logs() {
  const auth = useAuth();
  const isAdmin = !!auth.user?.is_admin;

  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [level, setLevel] = useState<LevelFilter>('ALL');
  const [query, setQuery] = useState('');
  const [live, setLive] = useState(true);
  const [nonce, setNonce] = useState(0);
  const lastSeq = useRef(0);

  useEffect(() => {
    if (!isAdmin) return;
    if (!live) {
      setConn('paused');
      return;
    }
    setConn('connecting');
    const es = new EventSource('/api/logs/stream');

    // Every connect replays a backlog, so rebuilding from scratch here keeps
    // reconnects — and a server restart, which resets seq to 1 — self-healing.
    es.onopen = () => {
      lastSeq.current = 0;
      setEntries([]);
      setConn('live');
    };

    es.onmessage = (ev) => {
      let entry: LogEntry;
      try {
        entry = JSON.parse(ev.data) as LogEntry;
      } catch {
        return;
      }
      // Swallow the backlog/live overlap at the seam.
      if (entry.seq <= lastSeq.current) return;
      lastSeq.current = entry.seq;
      setEntries((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_ENTRIES
          ? next.slice(next.length - MAX_ENTRIES)
          : next;
      });
      setConn('live');
    };

    // EventSource retries on its own; just reflect the state.
    es.onerror = () => setConn('error');

    return () => es.close();
  }, [isAdmin, live, nonce]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries
      .filter((e) => level === 'ALL' || e.level.toUpperCase() === level)
      .filter(
        (e) =>
          !q ||
          e.message.toLowerCase().includes(q) ||
          e.target.toLowerCase().includes(q),
      )
      .slice()
      .reverse(); // newest first — the interesting end of a log
  }, [entries, level, query]);

  if (!isAdmin) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-6 py-10">
          <h1 className="text-3xl font-medium tracking-tight text-foreground">
            运行日志
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            只有管理员可以查看运行日志。
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-10">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-3xl font-medium tracking-tight text-foreground">
            运行日志
          </h1>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs',
              conn === 'live' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700',
              conn === 'error' && 'border-destructive/30 bg-destructive/10 text-destructive',
              (conn === 'connecting' || conn === 'paused') &&
                'border-border bg-accent text-muted-foreground',
            )}
          >
            <Radio className={cn('size-3', conn === 'live' && 'animate-pulse')} />
            {CONN_LABEL[conn]}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          服务端日志实时推送(SSE,INFO 及以上)。日志存在内存里,重启后清空。
        </p>

        <div className="mt-6 mb-4 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            {LEVELS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLevel(l)}
                className={cn(
                  'rounded-md px-2.5 py-1.5 text-xs transition',
                  level === l
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-accent',
                )}
              >
                {l === 'ALL' ? '全部' : l}
              </button>
            ))}
          </div>

          <div className="relative min-w-48 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索内容或来源"
              className="pl-9"
            />
          </div>

          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={live}
              onChange={(e) => setLive(e.target.checked)}
              className="accent-primary"
            />
            实时接收
          </label>

          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            disabled={!live}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground transition hover:bg-accent disabled:opacity-40"
          >
            <RefreshCw className="size-3.5" />
            重连
          </button>

          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {visible.length} / {entries.length} 条
          </span>
        </div>

        {visible.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            {entries.length === 0
              ? conn === 'error'
                ? '连接不上日志流,正在重试…'
                : '暂无日志。服务重启后会从这里重新开始记录。'
              : '没有匹配的日志。'}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {visible.map((e) => (
              <div
                key={e.seq}
                className="flex items-start gap-3 border-b border-border px-4 py-2 last:border-b-0"
              >
                <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
                  {fmtTime(e.ts)}
                </span>
                <span
                  className={cn(
                    'shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium',
                    LEVEL_STYLE[e.level.toUpperCase()] ?? LEVEL_STYLE.INFO,
                  )}
                >
                  {e.level.toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="break-words font-mono text-xs leading-relaxed text-foreground">
                    {e.message}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {e.target}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
