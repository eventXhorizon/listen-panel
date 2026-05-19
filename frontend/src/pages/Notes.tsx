import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { deleteNote, listMaterials, listNotes } from '../api';
import type { Material, MaterialNote } from '../types';

export default function Notes() {
  const [items, setItems] = useState<MaterialNote[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'all' | number>('all');
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [notes, mats] = await Promise.all([listNotes(), listMaterials()]);
      setItems(notes);
      setMaterials(mats);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const materialMap = useMemo(() => {
    const map = new Map<number, Material>();
    for (const material of materials) map.set(material.id, material);
    return map;
  }, [materials]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return items.filter((note) => {
      if (scope !== 'all' && note.material_id !== scope) return false;
      if (!ql) return true;
      const title =
        note.material_title ?? materialMap.get(note.material_id)?.title ?? '';
      return (
        title.toLowerCase().includes(ql) ||
        note.content.toLowerCase().includes(ql) ||
        note.anchor_text.toLowerCase().includes(ql)
      );
    });
  }, [items, materialMap, q, scope]);

  async function onDelete(id: number) {
    if (!confirm('确定删除这条笔记?')) return;
    await deleteNote(id);
    setItems((next) => next.filter((item) => item.id !== id));
  }

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-10">
        <div className="mb-6 flex items-baseline justify-between">
          <h1 className="text-2xl font-medium tracking-tight text-foreground">
            笔记
          </h1>
          <span className="text-sm text-muted-foreground">
            {filtered.length} / {items.length}
          </span>
        </div>

        <div className="mb-6 flex flex-wrap gap-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索笔记、原文、文章标题..."
            className="min-w-[220px] flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:border-border"
          />
          <select
            value={scope === 'all' ? 'all' : String(scope)}
            onChange={(e) =>
              setScope(e.target.value === 'all' ? 'all' : Number(e.target.value))
            }
            className="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:border-border"
          >
            <option value="all">全部材料</option>
            {materials.map((material) => (
              <option key={material.id} value={material.id}>
                {material.title}
              </option>
            ))}
          </select>
        </div>

        {loading && <p className="text-sm text-muted-foreground">加载中...</p>}

        {error && (
          <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center">
            <p className="text-muted-foreground">
              {items.length === 0 ? '还没有笔记' : '没有匹配的笔记'}
            </p>
          </div>
        )}

        <ul className="space-y-3">
          {filtered.map((note) => {
            const material = materialMap.get(note.material_id);
            const title = note.material_title ?? material?.title ?? '未知材料';
            return (
              <li
                key={note.id}
                className="rounded-lg border border-border bg-card p-4"
              >
                <div className="mb-2 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <Link
                      to={`/m/${note.material_id}`}
                      className="block truncate text-sm font-medium text-foreground hover:underline"
                      title={title}
                    >
                      {title}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/70">
                      <span>{noteTargetLabel(note)}</span>
                      <span>{new Date(note.updated_at).toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Link
                      to={`/m/${note.material_id}`}
                      className="text-xs font-medium text-primary hover:text-primary"
                    >
                      打开文章
                    </Link>
                    <button
                      type="button"
                      onClick={() => onDelete(note.id)}
                      className="text-xs text-muted-foreground/70 hover:text-destructive"
                    >
                      删除
                    </button>
                  </div>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground">
                  {note.content}
                </p>
                {note.anchor_text && (
                  <p className="mt-3 border-l-2 border-border pl-3 text-xs leading-6 text-muted-foreground">
                    {note.anchor_text}
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

function noteTargetLabel(note: MaterialNote): string {
  if (note.target_type === 'segment') return '转写分段';
  const index = note.paragraph_index == null ? null : note.paragraph_index + 1;
  return index == null ? '段落' : `第 ${index} 段`;
}
