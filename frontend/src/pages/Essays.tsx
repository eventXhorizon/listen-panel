import { useEffect, useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import {
  Loader2,
  Sparkles,
  Globe,
  ClipboardPaste,
  Trash2,
  ExternalLink,
  PlayCircle,
} from 'lucide-react';
import {
  deleteEssay,
  fetchEssayFromUrl,
  generateEssay,
  importManualEssay,
  listEssayClassics,
  listEssays,
} from '../api';
import type {
  EssayClassic,
  EssaySource,
  EssayStyle,
  ModelEssay,
  ModelEssaySummary,
} from '../types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const STYLE_OPTIONS: { value: EssayStyle; label: string; hint: string }[] = [
  { value: 'paul_graham', label: 'Paul Graham', hint: '口语化但精确,短句多' },
  { value: 'economist', label: 'Economist op-ed', hint: '正式严谨,信息密度高' },
  { value: 'atlantic', label: 'Atlantic essay', hint: '叙事开场,长短句节奏' },
  { value: 'speech', label: '演讲稿', hint: '第二人称,重复并列,适合背' },
  { value: 'narrative', label: '叙事散文', hint: '具体场景,感官细节' },
  { value: 'op_ed', label: '时评', hint: '观点鲜明,800 词紧凑' },
  { value: 'other', label: '通用', hint: '不偏向特定风格' },
];

const STYLE_LABEL: Record<EssayStyle, string> = {
  paul_graham: 'Paul Graham',
  economist: 'Economist',
  atlantic: 'Atlantic',
  speech: '演讲',
  narrative: '叙事',
  op_ed: '时评',
  other: '通用',
};

const SOURCE_LABEL: Record<EssaySource, string> = {
  llm: '🤖 LLM 生成',
  web: '🌐 抓取',
  manual: '📋 粘贴',
};

const SOURCE_TONE: Record<EssaySource, string> = {
  llm: 'bg-violet-100 text-violet-800 border-violet-200',
  web: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  manual: 'bg-sky-100 text-sky-800 border-sky-200',
};

/** Top-level layout for /essays. The list view lives here; the detail
 *  view renders via <Outlet /> when the route is /essays/:id. */
export default function Essays() {
  return <Outlet />;
}

export function EssaysIndex() {
  const [items, setItems] = useState<ModelEssaySummary[]>([]);
  const [classics, setClassics] = useState<EssayClassic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [list, cls] = await Promise.all([listEssays(), listEssayClassics()]);
      setItems(list);
      setClassics(cls);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function onDelete(id: number) {
    if (!confirm('删除这篇范文?')) return;
    await deleteEssay(id);
    setItems((prev) => prev.filter((x) => x.id !== id));
  }

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-6 py-10">
        <div className="mb-6">
          <h1 className="text-2xl font-medium tracking-tight text-foreground">
            范文学习
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            找一篇好英文,精读、做笔记、把句型搬走 — 写作的底子来自输入,不是反复润色。
          </p>
        </div>

        <ImportBar onAdded={refresh} />

        <ClassicsList classics={classics} onAdded={refresh} />

        <section className="mt-10">
          <h2 className="mb-3 text-lg font-medium text-foreground">我的范文</h2>
          {loading && <p className="text-sm text-muted-foreground">加载中...</p>}
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {!loading && !error && items.length === 0 && (
            <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
              还没有范文。试试上面"经典范文"里的一键导入,或者自己生成一篇。
            </div>
          )}
          {!loading && items.length > 0 && (
            <ul className="grid gap-3 sm:grid-cols-2">
              {items.map((x) => (
                <li
                  key={x.id}
                  className="group rounded-lg border border-border bg-card p-4 transition hover:border-foreground/20"
                >
                  <Link to={`/essays/${x.id}`} className="block">
                    <div className="mb-1 flex items-start justify-between gap-2">
                      <h3 className="line-clamp-2 text-sm font-medium leading-5 text-foreground">
                        {x.title}
                      </h3>
                      <span
                        className={cn(
                          'shrink-0 rounded border px-1.5 py-0.5 text-[10px]',
                          SOURCE_TONE[x.source],
                        )}
                      >
                        {SOURCE_LABEL[x.source]}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
                      {x.author && <span>{x.author}</span>}
                      <span className="rounded bg-accent px-1.5 py-0.5 text-foreground/70">
                        {STYLE_LABEL[x.style] ?? x.style}
                      </span>
                      {x.video_url && (
                        <PlayCircle
                          className="size-3 text-rose-500"
                          aria-label="带演讲视频"
                        />
                      )}
                      <span>·</span>
                      <span>{x.word_count} 词</span>
                      <span>·</span>
                      <span>{new Date(x.created_at).toLocaleDateString()}</span>
                    </div>
                    {x.topic && (
                      <p className="mt-1 line-clamp-1 text-[11px] italic text-muted-foreground/70">
                        题目: {x.topic}
                      </p>
                    )}
                  </Link>
                  <div className="mt-2 flex items-center justify-end gap-2">
                    {x.source_url && (
                      <a
                        href={x.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                        title="原文链接"
                      >
                        <ExternalLink className="size-4" />
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => onDelete(x.id)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="删除"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

// ===================== Import bar (3 modes) =====================

type Mode = 'generate' | 'url' | 'manual';

function ImportBar({ onAdded }: { onAdded: () => void }) {
  const [mode, setMode] = useState<Mode>('generate');
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // form state, kept here so switching modes doesn't lose unrelated input
  const [topic, setTopic] = useState('');
  const [style, setStyle] = useState<EssayStyle>('paul_graham');
  const [length, setLength] = useState<'short' | 'medium' | 'long'>('medium');
  const [url, setUrl] = useState('');
  const [manualText, setManualText] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [manualAuthor, setManualAuthor] = useState('');
  const [manualVideoUrl, setManualVideoUrl] = useState('');

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      let essay: ModelEssay;
      if (mode === 'generate') {
        if (!topic.trim()) throw new Error('题目不能为空');
        essay = await generateEssay({ topic: topic.trim(), style, length });
      } else if (mode === 'url') {
        if (!url.trim()) throw new Error('URL 不能为空');
        essay = await fetchEssayFromUrl({ url: url.trim() });
      } else {
        if (!manualText.trim()) throw new Error('正文不能为空');
        essay = await importManualEssay({
          text: manualText.trim(),
          title: manualTitle.trim() || undefined,
          author: manualAuthor.trim() || undefined,
          video_url: manualVideoUrl.trim() || undefined,
        });
      }
      onAdded();
      navigate(`/essays/${essay.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-8 rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex gap-1 rounded-md border border-border bg-background p-1">
        <ModeButton
          active={mode === 'generate'}
          onClick={() => setMode('generate')}
          icon={<Sparkles className="size-4" />}
          label="生成"
        />
        <ModeButton
          active={mode === 'url'}
          onClick={() => setMode('url')}
          icon={<Globe className="size-4" />}
          label="抓取 URL"
        />
        <ModeButton
          active={mode === 'manual'}
          onClick={() => setMode('manual')}
          icon={<ClipboardPaste className="size-4" />}
          label="粘贴文本"
        />
      </div>

      {mode === 'generate' && (
        <div className="flex flex-col gap-3">
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="题目或写作意图(中英文都行)... 例如:为什么深度工作很难"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap gap-2 text-xs">
            <select
              value={style}
              onChange={(e) => setStyle(e.target.value as EssayStyle)}
              className="rounded-md border border-border bg-background px-2 py-1.5"
            >
              {STYLE_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label} — {s.hint}
                </option>
              ))}
            </select>
            <select
              value={length}
              onChange={(e) =>
                setLength(e.target.value as 'short' | 'medium' | 'long')
              }
              className="rounded-md border border-border bg-background px-2 py-1.5"
            >
              <option value="short">短 (~250 词)</option>
              <option value="medium">中 (~450 词)</option>
              <option value="long">长 (~700 词)</option>
            </select>
          </div>
        </div>
      )}

      {mode === 'url' && (
        <div className="flex flex-col gap-2">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://paulgraham.com/ds.html"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <p className="text-[11px] leading-4 text-muted-foreground">
            支持静态博客、公共域演讲稿、非付费 op-ed。付费墙(NYT / FT / 经济学人)
            会失败 — 那种情况下复制正文用"粘贴文本"。
          </p>
        </div>
      )}

      {mode === 'manual' && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={manualTitle}
              onChange={(e) => setManualTitle(e.target.value)}
              placeholder="标题(可选,留空让 LLM 起)"
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <input
              type="text"
              value={manualAuthor}
              onChange={(e) => setManualAuthor(e.target.value)}
              placeholder="作者(可选)"
              className="w-40 rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <input
            type="url"
            value={manualVideoUrl}
            onChange={(e) => setManualVideoUrl(e.target.value)}
            placeholder="演讲视频链接(可选,如 YouTube)... 适用于 Steve Jobs 这种有原始视频的演讲"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <Textarea
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            placeholder="把英文文章正文粘贴进来,LLM 会标出语言点和段落作用..."
            className="min-h-[160px] text-sm leading-7"
          />
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="mt-3 flex justify-end">
        <Button onClick={submit} disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {busy
            ? mode === 'generate'
              ? '生成中...'
              : '处理中...'
            : mode === 'generate'
              ? '生成范文'
              : mode === 'url'
                ? '抓取并分析'
                : '提交分析'}
        </Button>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1.5 text-sm transition',
        active
          ? 'bg-accent text-foreground font-medium'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ===================== Classics list =====================

function ClassicsList({
  classics,
  onAdded,
}: {
  classics: EssayClassic[];
  onAdded: () => void;
}) {
  const navigate = useNavigate();
  const [busyUrl, setBusyUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function importOne(c: EssayClassic) {
    setBusyUrl(c.url);
    setError(null);
    try {
      const essay = await fetchEssayFromUrl({
        url: c.url,
        author_hint: c.author,
        style: c.style,
        video_url: c.video_url,
      });
      onAdded();
      navigate(`/essays/${essay.id}`);
    } catch (e) {
      setError(`${c.title}: ${(e as Error).message}`);
    } finally {
      setBusyUrl(null);
    }
  }

  if (classics.length === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="mb-1 text-lg font-medium text-foreground">经典范文</h2>
      <p className="mb-3 text-[11px] text-muted-foreground">
        手工挑过的"值得背"清单。点"导入"即抓取原文 + LLM 分析,存到你的范文库。
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {classics.map((c) => (
          <li
            key={c.url}
            className="flex items-start justify-between gap-2 rounded-md border border-border bg-card p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-5 text-foreground">
                {c.title}
              </p>
              <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
                <span>{c.author}</span>
                <span>·</span>
                <span className="rounded bg-accent px-1.5 py-0.5 text-foreground/70">
                  {STYLE_LABEL[c.style] ?? c.style}
                </span>
                {c.video_url && (
                  <span
                    className="inline-flex items-center gap-0.5 rounded-full border border-rose-300 bg-rose-50 px-1.5 py-0 text-[10px] text-rose-700"
                    title="带演讲视频"
                  >
                    <PlayCircle className="size-2.5" />
                    视频
                  </span>
                )}
              </p>
              <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                {c.blurb}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => importOne(c)}
                disabled={busyUrl === c.url}
              >
                {busyUrl === c.url ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                {busyUrl === c.url ? '抓取中...' : '导入'}
              </Button>
              <a
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                看原文
              </a>
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
    </section>
  );
}

export { SOURCE_LABEL, SOURCE_TONE, STYLE_LABEL };
