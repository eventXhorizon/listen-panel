import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { listMaterials, listVocab, updateVocab } from '../api';
import type { Material, VocabEntry } from '../types';

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function maskWord(context: string, word: string): ReactNode[] {
  if (!word) return [context];
  const re = new RegExp(`\\b${word.replace(ESCAPE, '\\$&')}\\b`, 'gi');
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(context)) !== null) {
    if (m.index > last) parts.push(context.slice(last, m.index));
    parts.push(
      <span
        key={m.index}
        className="bg-stone-200 text-stone-200 rounded px-1 select-none"
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
            <h1 className="text-2xl font-medium text-stone-900 mb-2">生词复习</h1>
            <p className="text-sm text-stone-500">
              翻卡片复习,根据上下文回想词义。
            </p>
          </div>

          <div className="space-y-5 bg-white border border-stone-200 rounded-lg p-6">
            <div>
              <div className="text-sm font-medium text-stone-800 mb-2">范围</div>
              <select
                value={scope === 'all' ? 'all' : String(scope)}
                onChange={(e) =>
                  setScope(
                    e.target.value === 'all' ? 'all' : Number(e.target.value),
                  )
                }
                className="w-full bg-white border border-stone-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-stone-400"
              >
                <option value="all">全部材料</option>
                {materials.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-stone-700 cursor-pointer">
              <input
                type="checkbox"
                checked={includeMastered}
                onChange={(e) => setIncludeMastered(e.target.checked)}
              />
              包含已掌握的(三点全亮)
            </label>
            <p className="text-xs text-stone-500">
              本次将复习{' '}
              <strong className="text-stone-900">{candidates.length}</strong> 个词
            </p>
          </div>

          <div className="text-center mt-6">
            <button
              onClick={start}
              disabled={candidates.length === 0}
              className="px-6 py-2.5 rounded-md bg-stone-900 text-white text-sm hover:bg-stone-700 disabled:opacity-50"
            >
              开始
            </button>
          </div>
          <div className="text-center mt-4">
            <Link
              to="/vocab"
              className="text-xs text-stone-500 hover:text-stone-900"
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
          <h1 className="text-2xl font-medium text-stone-900 mb-2">复习完成</h1>
          <p className="text-sm text-stone-500 mb-8">
            本轮 {queue.length} 个词已过。
          </p>
          <button
            onClick={() => setStarted(false)}
            className="px-4 py-2 rounded-md border border-stone-200 text-sm hover:bg-stone-50 mr-2"
          >
            再来一轮
          </button>
          <Link
            to="/vocab"
            className="inline-block px-4 py-2 rounded-md bg-stone-900 text-white text-sm hover:bg-stone-700"
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
        <div className="flex items-center justify-between mb-6 text-xs text-stone-500">
          <span>
            {idx + 1} / {queue.length}
          </span>
          <button
            onClick={() => setStarted(false)}
            className="hover:text-stone-900"
          >
            退出
          </button>
        </div>

        <div className="bg-white border border-stone-200 rounded-xl p-8 min-h-[320px] flex flex-col">
          <div className="text-center mb-6">
            <div className="text-3xl font-medium text-stone-900 break-words">
              {cur.word}
            </div>
            {cur.phonetic && (
              <div className="text-sm text-stone-500 font-mono mt-1">
                {cur.phonetic}
              </div>
            )}
          </div>

          {cur.context && (
            <div className="text-sm text-stone-600 leading-relaxed border-l-2 border-stone-200 pl-3 mb-6">
              {revealed ? cur.context : maskWord(cur.context, cur.word)}
            </div>
          )}

          <div className="flex-1 flex items-center justify-center">
            {!revealed ? (
              <button
                onClick={() => setRevealed(true)}
                className="px-6 py-2 rounded-md bg-stone-100 text-stone-800 text-sm hover:bg-stone-200"
              >
                显示释义
              </button>
            ) : (
              <div className="text-center">
                {cur.pos && (
                  <div className="text-xs text-stone-500 italic mb-1">
                    {cur.pos}
                  </div>
                )}
                <div className="text-base text-stone-900 leading-relaxed">
                  {cur.definition_zh}
                </div>
                {cur.definition_en && (
                  <div className="text-sm text-stone-500 leading-relaxed mt-1">
                    {cur.definition_en}
                  </div>
                )}
                {cur.example_zh && (
                  <div className="text-xs text-stone-500 italic mt-3">
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
              className="py-2 rounded-md border border-rose-200 text-rose-700 text-sm hover:bg-rose-50"
            >
              不记得
            </button>
            <button
              onClick={() => judge(0)}
              className="py-2 rounded-md border border-stone-200 text-stone-700 text-sm hover:bg-stone-50"
            >
              模糊
            </button>
            <button
              onClick={() => judge(1)}
              className="py-2 rounded-md border border-emerald-200 text-emerald-700 text-sm hover:bg-emerald-50"
            >
              记得
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
