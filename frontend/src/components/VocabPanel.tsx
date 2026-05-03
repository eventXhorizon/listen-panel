import { Link } from 'react-router-dom';
import type { VocabEntry } from '../types';
import { deleteVocab } from '../api';

interface Props {
  items: VocabEntry[];
  onClose: () => void;
  onChange: () => void;
}

export default function VocabPanel({ items, onClose, onChange }: Props) {
  async function onDelete(id: number) {
    if (!confirm('确定删除这条生词?')) return;
    await deleteVocab(id);
    onChange();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between shrink-0">
          <h2 className="text-base font-medium text-stone-900">
            本篇生词 ({items.length})
          </h2>
          <div className="flex items-center gap-3">
            <Link
              to="/vocab"
              onClick={onClose}
              className="text-xs text-stone-500 hover:text-stone-900"
            >
              查看全部 →
            </Link>
            <button
              onClick={onClose}
              className="text-stone-400 hover:text-stone-700 text-xl leading-none"
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {items.length === 0 && (
            <p className="text-sm text-stone-500 text-center py-8">
              还没有生词。在原文里选中一段文字试试。
            </p>
          )}
          <ul className="space-y-3">
            {items.map((v) => (
              <li
                key={v.id}
                className="border border-stone-200 rounded-lg p-3 group"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="flex items-baseline gap-2 flex-wrap min-w-0">
                    <span className="text-base font-medium text-stone-900">
                      {v.word}
                    </span>
                    {v.lemma &&
                      v.lemma.toLowerCase() !== v.word.toLowerCase() && (
                        <span className="text-xs text-stone-400">
                          ({v.lemma})
                        </span>
                      )}
                    {v.phonetic && (
                      <span className="text-xs text-stone-500 font-mono">
                        {v.phonetic}
                      </span>
                    )}
                    {v.pos && (
                      <span className="text-xs text-stone-500 italic">
                        {v.pos}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => onDelete(v.id)}
                    className="text-xs text-stone-400 hover:text-rose-600 opacity-0 group-hover:opacity-100"
                  >
                    删除
                  </button>
                </div>
                <p className="mt-1 text-sm text-stone-700 leading-relaxed">
                  {v.definition_zh}
                </p>
                {v.context && (
                  <p className="mt-1.5 text-xs text-stone-500 italic line-clamp-2">
                    "{v.context}"
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
