import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { deleteVocab, listMaterials, listVocab } from '../api';
import type { Material, VocabEntry } from '../types';
import SpeakButton from '../components/SpeakButton';
import { languageLabel } from '../lib/languages';

export default function Vocab() {
  const [items, setItems] = useState<VocabEntry[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'all' | number>('all');

  async function refresh() {
    setLoading(true);
    const [vs, ms] = await Promise.all([listVocab(), listMaterials()]);
    setItems(vs);
    setMaterials(ms);
    setLoading(false);
  }

  useEffect(() => {
    refresh();
  }, []);

  const materialMap = useMemo(() => {
    const m = new Map<number, Material>();
    for (const x of materials) m.set(x.id, x);
    return m;
  }, [materials]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return items.filter((v) => {
      if (scope !== 'all' && v.material_id !== scope) return false;
      if (!ql) return true;
      return (
        v.word.toLowerCase().includes(ql) ||
        v.lemma.toLowerCase().includes(ql) ||
        v.definition_zh.includes(ql) ||
        (v.definition_en?.toLowerCase().includes(ql) ?? false)
      );
    });
  }, [items, q, scope]);

  async function onDelete(id: number) {
    if (!confirm('确定删除这条生词?')) return;
    await deleteVocab(id);
    refresh();
  }

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-10 w-full">
        <div className="flex items-baseline justify-between mb-6">
          <h1 className="text-2xl font-medium text-foreground tracking-tight">
            生词本
          </h1>
          <span className="text-sm text-muted-foreground">
            {filtered.length} / {items.length}
          </span>
        </div>

        <div className="flex flex-wrap gap-3 mb-6">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索词、释义..."
            className="flex-1 min-w-[200px] bg-card border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-border"
          />
          <select
            value={scope === 'all' ? 'all' : String(scope)}
            onChange={(e) =>
              setScope(e.target.value === 'all' ? 'all' : Number(e.target.value))
            }
            className="bg-card border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-border"
          >
            <option value="all">全部材料</option>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
          <Link
            to="/review"
            className="px-3 py-2 rounded-md bg-foreground text-white text-sm hover:bg-foreground/85"
          >
            开始复习
          </Link>
        </div>

        {loading && <p className="text-muted-foreground text-sm">加载中...</p>}

        {!loading && filtered.length === 0 && (
          <div className="border border-dashed border-border rounded-lg p-12 text-center bg-card">
            <p className="text-muted-foreground">
              {items.length === 0
                ? '生词本还是空的,去 Reader 选词加进来吧'
                : '没有匹配的生词'}
            </p>
          </div>
        )}

        <ul className="space-y-3">
          {filtered.map((v) => {
            const mat = materialMap.get(v.material_id);
            return (
              <li
                key={v.id}
                className="border border-border rounded-lg p-4 bg-card group"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="flex items-baseline gap-2 flex-wrap min-w-0">
                    <span className="text-lg font-medium text-foreground">
                      {v.word}
                    </span>
                    <SpeakButton
                      word={v.word}
                      materialId={v.material_id}
                      language={v.language}
                    />
                    <span className="rounded bg-accent px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {languageLabel(v.language)}
                    </span>
                    {v.lemma &&
                      v.lemma.toLowerCase() !== v.word.toLowerCase() && (
                        <span className="text-xs text-muted-foreground/70">
                          ({v.lemma})
                        </span>
                      )}
                    {v.phonetic && (
                      <span className="text-xs text-muted-foreground font-mono">
                        {v.phonetic}
                      </span>
                    )}
                    {v.pos && (
                      <span className="text-xs text-muted-foreground italic">
                        {v.pos}
                      </span>
                    )}
                    <MasteryDots level={v.mastery} />
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {mat && (
                      <Link
                        to={`/m/${mat.id}`}
                        className="text-xs text-muted-foreground hover:text-foreground truncate max-w-[140px]"
                        title={mat.title}
                      >
                        {mat.title}
                      </Link>
                    )}
                    <button
                      onClick={() => onDelete(v.id)}
                      className="text-xs text-muted-foreground/70 hover:text-destructive opacity-0 group-hover:opacity-100"
                    >
                      删除
                    </button>
                  </div>
                </div>
                <p className="mt-1.5 text-sm text-foreground leading-relaxed">
                  {v.definition_zh}
                </p>
                {v.definition_en && (
                  <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                    {v.definition_en}
                  </p>
                )}
                {v.context && (
                  <p className="mt-2 text-xs text-muted-foreground italic">
                    "{v.context}"
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </main>
  );
}

function MasteryDots({ level }: { level: number }) {
  return (
    <span className="inline-flex gap-0.5 ml-1" title={`掌握度 ${level}/3`}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`w-1.5 h-1.5 rounded-full ${i < level ? 'bg-success/100' : 'bg-secondary'}`}
        />
      ))}
    </span>
  );
}
