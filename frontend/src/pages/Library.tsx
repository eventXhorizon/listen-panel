import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, Trash2 } from 'lucide-react';
import { listMaterials, deleteMaterial } from '../api';
import type { Material, MaterialLanguage, SourceType } from '../types';
import { languageLabel } from '../lib/languages';
import { textSourceLabel } from '../lib/textSources';
import { materialCoverUrl } from '../lib/materialCover';
import { getLastOpenedMap } from '../lib/lastOpened';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const SOURCE_LABEL: Record<SourceType, string> = {
  local: '本地',
  youtube: 'YouTube',
  bilibili: 'Bilibili',
};

const LANGUAGE_ORDER: MaterialLanguage[] = ['ja', 'en'];

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

export default function Library() {
  const [items, setItems] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [lastOpened, setLastOpened] = useState<Record<number, number>>({});

  async function refresh() {
    setItems(await listMaterials());
  }

  useEffect(() => {
    let cancelled = false;
    setLastOpened(getLastOpenedMap());
    listMaterials()
      .then((next) => {
        if (!cancelled) setItems(next);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onDelete(e: React.MouseEvent, id: number) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('确定删除这条材料?')) return;
    await deleteMaterial(id);
    refresh();
  }

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? items.filter(
          (m) =>
            m.title.toLowerCase().includes(q) ||
            m.text.toLowerCase().includes(q),
        )
      : items;

    const byLang = new Map<MaterialLanguage, Material[]>();
    for (const m of filtered) {
      const list = byLang.get(m.language) ?? [];
      list.push(m);
      byLang.set(m.language, list);
    }
    for (const list of byLang.values()) {
      list.sort((a, b) => {
        const la = lastOpened[a.id] ?? new Date(a.updated_at).getTime();
        const lb = lastOpened[b.id] ?? new Date(b.updated_at).getTime();
        return lb - la;
      });
    }
    return LANGUAGE_ORDER.flatMap((lang) => {
      const list = byLang.get(lang);
      return list && list.length > 0 ? [{ lang, items: list }] : [];
    });
  }, [items, query, lastOpened]);

  const totalShown = grouped.reduce((sum, g) => sum + g.items.length, 0);

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-6 py-10">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-medium tracking-tight text-foreground">
              我的书架
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {loading
                ? '加载中…'
                : query
                  ? `${totalShown} / ${items.length} 条材料`
                  : `${items.length} 条材料`}
            </p>
          </div>
          <div className="flex w-full max-w-sm items-center gap-2 sm:w-auto">
            <div className="relative flex-1 sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索标题或原文"
                className="pl-9"
              />
            </div>
          </div>
        </div>

        {loading && <p className="text-sm text-muted-foreground">加载中…</p>}

        {!loading && items.length === 0 && (
          <div className="rounded-xl border border-dashed border-border bg-card p-12 text-center">
            <p className="mb-4 text-muted-foreground">书架空空,先去添加一条材料</p>
            <Button asChild>
              <Link to="/new">
                <Plus className="size-4" />
                创建第一条材料
              </Link>
            </Button>
          </div>
        )}

        {!loading && items.length > 0 && totalShown === 0 && (
          <p className="text-sm text-muted-foreground">没有匹配 “{query}” 的材料。</p>
        )}

        {!loading && grouped.length > 0 && (
          <div className="space-y-10">
            {grouped.map((group) => (
              <section key={group.lang}>
                <div className="mb-3 flex items-baseline gap-3">
                  <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                    {languageLabel(group.lang)}
                  </h2>
                  <span className="text-xs text-muted-foreground/70">
                    {group.items.length}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {group.items.map((m) => (
                    <MaterialCard
                      key={m.id}
                      material={m}
                      onDelete={(e) => onDelete(e, m.id)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function MaterialCard({
  material: m,
  onDelete,
}: {
  material: Material;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const cover = materialCoverUrl(m);
  return (
    <Link
      to={`/m/${m.id}`}
      className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-card transition hover:border-primary/40 hover:shadow-md hover:shadow-foreground/[0.04]"
    >
      <Cover material={m} cover={cover} />
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Badge variant="outline" className="border-border bg-background">
            {SOURCE_LABEL[m.source_type]}
          </Badge>
          {m.text.trim() && (
            <span className="truncate">{textSourceLabel(m.text_source)}</span>
          )}
        </div>
        <h3 className="line-clamp-2 text-[15px] font-medium leading-snug text-foreground">
          {m.title || '(无标题)'}
        </h3>
        <p className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
          {m.text || <span className="italic">尚无原文</span>}
        </p>
        <div className="mt-auto flex items-center justify-between pt-2 text-xs text-muted-foreground/80">
          <span>{formatRelative(m.updated_at)}</span>
          <button
            type="button"
            onClick={onDelete}
            aria-label="删除材料"
            className="inline-flex items-center gap-1 rounded text-muted-foreground/60 opacity-0 transition hover:text-destructive group-hover:opacity-100"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
    </Link>
  );
}

function Cover({ material: m, cover }: { material: Material; cover: string | null }) {
  const [errored, setErrored] = useState(false);
  const showImage = cover && !errored;

  return (
    <div
      className={cn(
        'relative aspect-video w-full overflow-hidden border-b border-border',
        !showImage && gradientForLanguage(m.language),
      )}
    >
      {showImage ? (
        <img
          src={cover}
          alt=""
          loading="lazy"
          onError={() => setErrored(true)}
          className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <span className="text-3xl font-semibold tracking-tight text-foreground/40">
            {(m.title || SOURCE_LABEL[m.source_type]).charAt(0).toUpperCase()}
          </span>
        </div>
      )}
      <Badge
        variant="secondary"
        className="absolute left-2 top-2 bg-background/85 text-foreground backdrop-blur"
      >
        {SOURCE_LABEL[m.source_type]}
      </Badge>
      <Badge
        variant="secondary"
        className="absolute right-2 top-2 bg-background/85 text-foreground backdrop-blur"
      >
        {languageLabel(m.language)}
      </Badge>
    </div>
  );
}

function gradientForLanguage(lang: MaterialLanguage): string {
  // Subtle on-brand gradients — amber for ja, stone for en. Tunable later.
  if (lang === 'ja') return 'bg-gradient-to-br from-amber-50 to-amber-100';
  return 'bg-gradient-to-br from-stone-100 to-stone-200';
}
