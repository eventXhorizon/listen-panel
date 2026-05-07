import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listMaterials, deleteMaterial } from '../api';
import type { Material, SourceType } from '../types';
import { languageLabel } from '../lib/languages';
import { textSourceLabel } from '../lib/textSources';

const SOURCE_LABEL: Record<SourceType, string> = {
  local: '本地',
  youtube: 'YouTube',
  bilibili: 'Bilibili',
};

export default function Library() {
  const [items, setItems] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    setItems(await listMaterials());
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;
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

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-10 w-full">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-2xl font-medium text-stone-900 tracking-tight">我的书架</h1>
        <span className="text-sm text-stone-500">{items.length} 条材料</span>
      </div>

      {loading && <p className="text-stone-500 text-sm">加载中...</p>}

      {!loading && items.length === 0 && (
        <div className="border border-dashed border-stone-300 rounded-lg p-12 text-center bg-white">
          <p className="text-stone-500 mb-4">书架空空,先去添加一条材料</p>
          <Link
            to="/new"
            className="inline-block px-4 py-2 rounded-md bg-stone-900 text-white text-sm hover:bg-stone-700"
          >
            创建第一条材料
          </Link>
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((m) => (
            <Link
              key={m.id}
              to={`/m/${m.id}`}
              className="group relative block border border-stone-200 rounded-lg bg-white p-5 hover:shadow-sm hover:border-stone-300 transition"
            >
              <div className="flex items-start justify-between mb-2">
                <span className="min-w-0 flex-1 text-[11px] text-stone-500 uppercase tracking-wider">
                  {SOURCE_LABEL[m.source_type]} · {languageLabel(m.language)}
                  {m.text.trim() && (
                    <>
                      {' '}· 来源: {textSourceLabel(m.text_source)}
                    </>
                  )}
                </span>
                <button
                  onClick={(e) => onDelete(e, m.id)}
                  className="text-xs text-stone-400 hover:text-rose-600 opacity-0 group-hover:opacity-100 transition"
                >
                  删除
                </button>
              </div>
              <h2 className="text-base font-medium text-stone-900 mb-2 line-clamp-1">
                {m.title}
              </h2>
              <p className="text-sm text-stone-500 line-clamp-3 leading-relaxed">
                {m.text || <span className="italic text-stone-400">(尚无原文)</span>}
              </p>
              <div className="mt-4 text-xs text-stone-400">
                {new Date(m.updated_at).toLocaleDateString()}
              </div>
            </Link>
          ))}
        </div>
      )}
      </div>
    </main>
  );
}
