import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { listNews, importNews, deleteNewsItem } from '../api';
import type { NewsItemSummary, NewsSource, NewsTopic } from '../types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type SourceFilter = NewsSource | 'all';
type TopicFilter = NewsTopic | 'all';
type DurationFilter = 'all' | 'short' | 'medium' | 'long';

const SOURCES: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'cnbc', label: 'CNBC International' },
  { value: 'bloomberg', label: 'Bloomberg' },
  { value: 'wsj', label: 'WSJ' },
  { value: 'ft', label: 'Financial Times' },
];

const TOPICS: { value: TopicFilter; label: string }[] = [
  { value: 'all', label: '全部话题' },
  { value: 'finance', label: '财经' },
  { value: 'politics', label: '政治' },
  { value: 'tech', label: '科技' },
  { value: 'culture', label: '文化' },
  { value: 'other', label: '其他' },
];

const DURATIONS: { value: DurationFilter; label: string }[] = [
  { value: 'all', label: '不限时长' },
  { value: 'short', label: '< 10 分钟' },
  { value: 'medium', label: '10–30 分钟' },
  { value: 'long', label: '> 30 分钟' },
];

const SOURCE_LABEL: Record<NewsSource, string> = {
  cnbc: 'CNBC',
  bloomberg: 'Bloomberg',
  wsj: 'WSJ',
  ft: 'FT',
};

const TOPIC_LABEL: Record<NewsTopic, string> = {
  finance: '财经',
  politics: '政治',
  tech: '科技',
  culture: '文化',
  other: '其他',
};

function formatRelative(iso: string): string {
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return '';
  const diff = Date.now() - d;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString();
}

function formatDuration(sec: number): string {
  if (sec <= 0) return '';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s === 0 ? `${m}:00` : `${m}:${String(s).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}:${String(mm).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function thumbUrl(item: NewsItemSummary): string {
  return (
    item.thumbnail_url ??
    `https://i.ytimg.com/vi/${item.yt_video_id}/mqdefault.jpg`
  );
}

export default function News() {
  const [items, setItems] = useState<NewsItemSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<SourceFilter>('all');
  const [topic, setTopic] = useState<TopicFilter>('all');
  const [duration, setDuration] = useState<DurationFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<number | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listNews({
      source: source === 'all' ? undefined : source,
      topic: topic === 'all' ? undefined : topic,
      duration: duration === 'all' ? undefined : duration,
    })
      .then((next) => {
        if (!cancelled) setItems(next);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, topic, duration]);

  async function onImport(item: NewsItemSummary) {
    setImportingId(item.id);
    try {
      const material = await importNews(item.id);
      navigate(`/m/${material.id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`导入失败:${msg}`);
    } finally {
      setImportingId(null);
    }
  }

  async function onDelete(item: NewsItemSummary) {
    if (!confirm(`确定删除这条新闻?\n\n${item.title}`)) return;
    try {
      await deleteNewsItem(item.id);
      setItems((arr) => arr.filter((x) => x.id !== item.id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`删除失败:${msg}`);
    }
  }

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-6 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-medium tracking-tight text-foreground">
            英语新闻
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            真实语速、地道用法 — 加入书架后跟读练口语
          </p>
        </div>

        <div className="mb-8 space-y-3">
          <FilterRow
            label="来源"
            options={SOURCES}
            value={source}
            onChange={setSource}
          />
          <FilterRow
            label="话题"
            options={TOPICS}
            value={topic}
            onChange={setTopic}
          />
          <FilterRow
            label="时长"
            options={DURATIONS}
            value={duration}
            onChange={setDuration}
          />
        </div>

        {loading && (
          <p className="text-sm text-muted-foreground">加载中…</p>
        )}

        {!loading && error && (
          <p className="text-sm text-destructive">加载失败:{error}</p>
        )}

        {!loading && !error && items.length === 0 && (
          <div className="rounded-xl border border-dashed border-border bg-card p-12 text-center">
            <p className="text-muted-foreground">
              当前条件下没有新闻。如果是首次启动,等几分钟让后台抓取完成再回来。
            </p>
          </div>
        )}

        {!loading && items.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((it) => (
              <NewsCard
                key={it.id}
                item={it}
                onImport={onImport}
                onDelete={onDelete}
                isImporting={importingId === it.id}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function FilterRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition',
              value === o.value
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function NewsCard({
  item,
  onImport,
  onDelete,
  isImporting,
}: {
  item: NewsItemSummary;
  onImport: (item: NewsItemSummary) => void;
  onDelete: (item: NewsItemSummary) => void;
  isImporting: boolean;
}) {
  const [imgErrored, setImgErrored] = useState(false);
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition hover:border-primary/40 hover:shadow-md hover:shadow-foreground/[0.04]">
      <div className="relative aspect-video overflow-hidden bg-muted">
        {!imgErrored ? (
          <img
            src={thumbUrl(item)}
            alt=""
            loading="lazy"
            onError={() => setImgErrored(true)}
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/10 to-primary/20">
            <span className="text-3xl font-semibold text-foreground/40">
              {item.title.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <Badge
          variant="secondary"
          className="absolute left-2 top-2 bg-background/85 text-foreground backdrop-blur"
        >
          {SOURCE_LABEL[item.source]}
        </Badge>
        {item.duration_sec > 0 && (
          <Badge
            variant="secondary"
            className="absolute right-2 top-2 bg-background/85 text-foreground font-mono tabular-nums backdrop-blur"
          >
            {formatDuration(item.duration_sec)}
          </Badge>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <Badge variant="outline" className="border-border">
            {TOPIC_LABEL[item.topic]}
          </Badge>
          <span>难度 {item.difficulty}/5</span>
          <span>·</span>
          <span>{formatRelative(item.published_at)}</span>
        </div>
        <h3 className="line-clamp-2 text-[15px] font-medium leading-snug text-foreground">
          {item.title}
        </h3>
        {item.description && (
          <p className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
            {item.description}
          </p>
        )}
        <div className="mt-auto flex items-center gap-2 pt-2">
          <Button
            onClick={() => onImport(item)}
            disabled={isImporting}
            size="sm"
            className="flex-1"
          >
            {isImporting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                正在加入…
              </>
            ) : (
              <>
                <Plus className="size-4" />
                加入书架并跟读
              </>
            )}
          </Button>
          <button
            type="button"
            onClick={() => onDelete(item)}
            aria-label="删除这条新闻"
            title="从新闻库删除(全局)"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>
    </article>
  );
}
