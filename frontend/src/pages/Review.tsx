import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { listMaterials, listVocab, updateVocab } from '../api';
import type { Material, MaterialLanguage, VocabEntry } from '../types';
import SpeakButton from '../components/SpeakButton';

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function maskWord(
  context: string,
  word: string,
  language: MaterialLanguage,
): ReactNode[] {
  if (!word) return [context];
  const pattern = word.replace(ESCAPE, '\\$&');
  const re =
    language === 'ja'
      ? new RegExp(pattern, 'g')
      : new RegExp(`\\b${pattern}\\b`, 'gi');
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(context)) !== null) {
    if (m.index > last) parts.push(context.slice(last, m.index));
    parts.push(
      <span
        key={m.index}
        className="bg-foreground/15 text-transparent rounded px-1 select-none"
      >
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < context.length) parts.push(context.slice(last));
  return parts.length > 0 ? parts : [context];
}

export default function Review() {
  const [items, setItems] = useState<VocabEntry[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [scope, setScope] = useState<'all' | number>('all');
  const [includeMastered, setIncludeMastered] = useState(false);
  const [queue, setQueue] = useState<VocabEntry[]>([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    (async () => {
      const [vs, ms] = await Promise.all([listVocab(), listMaterials()]);
      setItems(vs);
      setMaterials(ms);
    })();
  }, []);

  const candidates = useMemo(() => {
    return items.filter((v) => {
      if (scope !== 'all' && v.material_id !== scope) return false;
      if (!includeMastered && v.mastery >= 3) return false;
      return true;
    });
  }, [items, scope, includeMastered]);

  function start() {
    setQueue(shuffle(candidates));
    setIdx(0);
    setRevealed(false);
    setStarted(true);
  }

  async function judge(delta: number) {
    const cur = queue[idx];
    if (!cur) return;
    const newMastery = Math.max(0, Math.min(3, cur.mastery + delta));
    if (newMastery !== cur.mastery) {
      await updateVocab(cur.id, { mastery: newMastery });
      setItems((arr) =>
        arr.map((v) => (v.id === cur.id ? { ...v, mastery: newMastery } : v)),
      );
    }
    setRevealed(false);
    setIdx((i) => i + 1);
  }

  if (!started) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-6 py-12 w-full">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-medium text-foreground mb-2">生词复习</h1>
            <p className="text-sm text-muted-foreground">
              翻卡片复习,根据上下文回想词义。
            </p>
          </div>

          <div className="space-y-5 bg-card border border-border rounded-lg p-6">
            <div>
              <div className="text-sm font-medium text-foreground mb-2">范围</div>
              <select
                value={scope === 'all' ? 'all' : String(scope)}
                onChange={(e) =>
                  setScope(
                    e.target.value === 'all' ? 'all' : Number(e.target.value),
                  )
                }
                className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-border"
              >
                <option value="all">全部材料</option>
                {materials.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-foreground/85 cursor-pointer">
              <input
                type="checkbox"
                checked={includeMastered}
                onChange={(e) => setIncludeMastered(e.target.checked)}
              />
              包含已掌握的(三点全亮)
            </label>
            <p className="text-xs text-muted-foreground">
              本次将复习{' '}
              <strong className="text-foreground">{candidates.length}</strong> 个词
            </p>
          </div>

          <div className="text-center mt-6">
            <button
              onClick={start}
              disabled={candidates.length === 0}
              className="px-6 py-2.5 rounded-md bg-foreground text-white text-sm hover:bg-foreground/85 disabled:opacity-50"
            >
              开始
            </button>
          </div>
          <div className="text-center mt-4">
            <Link
              to="/vocab"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ← 返回生词本
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (idx >= queue.length) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-6 py-20 w-full text-center">
          <h1 className="text-2xl font-medium text-foreground mb-2">复习完成</h1>
          <p className="text-sm text-muted-foreground mb-8">
            本轮 {queue.length} 个词已过。
          </p>
          <button
            onClick={() => setStarted(false)}
            className="px-4 py-2 rounded-md border border-border text-sm hover:bg-accent/50 mr-2"
          >
            再来一轮
          </button>
          <Link
            to="/vocab"
            className="inline-block px-4 py-2 rounded-md bg-foreground text-white text-sm hover:bg-foreground/85"
          >
            返回生词本
          </Link>
        </div>
      </main>
    );
  }

  const cur = queue[idx];

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-10 w-full">
        <div className="flex items-center justify-between mb-6 text-xs text-muted-foreground">
          <span>
            {idx + 1} / {queue.length}
          </span>
          <button
            onClick={() => setStarted(false)}
            className="hover:text-foreground"
          >
            退出
          </button>
        </div>

        <div className="bg-card border border-border rounded-xl p-8 min-h-[320px] flex flex-col">
          <div className="text-center mb-6">
            <div className="flex items-center justify-center gap-2">
              <div className="text-3xl font-medium text-foreground break-words">
                {cur.word}
              </div>
              <SpeakButton
                word={cur.word}
                materialId={cur.material_id ?? undefined}
                language={cur.language}
                className="mt-1"
              />
            </div>
            {cur.phonetic && (
              <div className="text-sm text-muted-foreground font-mono mt-1">
                {cur.phonetic}
              </div>
            )}
          </div>

          {cur.context && (
            <div className="text-sm text-muted-foreground leading-relaxed border-l-2 border-border pl-3 mb-6">
              {revealed ? cur.context : maskWord(cur.context, cur.word, cur.language)}
            </div>
          )}

          <div className="flex-1 flex items-center justify-center">
            {!revealed ? (
              <button
                onClick={() => setRevealed(true)}
                className="px-6 py-2 rounded-md bg-accent text-foreground text-sm hover:bg-secondary/80"
              >
                显示释义
              </button>
            ) : (
              <div className="text-center">
                {cur.pos && (
                  <div className="text-xs text-muted-foreground italic mb-1">
                    {cur.pos}
                  </div>
                )}
                <div className="text-base text-foreground leading-relaxed">
                  {cur.definition_zh}
                </div>
                {cur.definition_en && (
                  <div className="text-sm text-muted-foreground leading-relaxed mt-1">
                    {cur.definition_en}
                  </div>
                )}
                {cur.example_zh && (
                  <div className="text-xs text-muted-foreground italic mt-3">
                    {cur.example_zh}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {revealed && (
          <div className="grid grid-cols-3 gap-2 mt-4">
            <button
              onClick={() => judge(-3)}
              className="py-2 rounded-md border border-destructive/30 text-destructive text-sm hover:bg-destructive/10"
            >
              不记得
            </button>
            <button
              onClick={() => judge(0)}
              className="py-2 rounded-md border border-border text-foreground/85 text-sm hover:bg-accent/50"
            >
              模糊
            </button>
            <button
              onClick={() => judge(1)}
              className="py-2 rounded-md border border-success/30 text-success text-sm hover:bg-success/10"
            >
              记得
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
