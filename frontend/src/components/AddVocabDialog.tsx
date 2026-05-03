import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { lookupWord } from '../lib/llm';
import { createVocab } from '../api';

interface Props {
  word: string;
  context: string;
  materialId: number;
  onClose: () => void;
  onSaved: () => void;
}

export default function AddVocabDialog({
  word,
  context,
  materialId,
  onClose,
  onSaved,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lemma, setLemma] = useState('');
  const [phonetic, setPhonetic] = useState('');
  const [pos, setPos] = useState('');
  const [definitionZh, setDefinitionZh] = useState('');
  const [definitionEn, setDefinitionEn] = useState('');
  const [exampleZh, setExampleZh] = useState('');
  const [contextEdit, setContextEdit] = useState(context);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await lookupWord(word, context);
        if (cancelled) return;
        setLemma(r.lemma || word);
        setPhonetic(r.phonetic ?? '');
        setPos(r.pos ?? '');
        setDefinitionZh(r.definition_zh ?? '');
        setDefinitionEn(r.definition_en ?? '');
        setExampleZh(r.example_zh ?? '');
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [word, context]);

  async function save() {
    if (!definitionZh.trim()) {
      alert('请填写中文释义');
      return;
    }
    setSaving(true);
    try {
      await createVocab({
        word: word.toLowerCase(),
        lemma: lemma.trim() || word,
        phonetic: phonetic.trim() || undefined,
        pos: pos.trim() || undefined,
        definition_zh: definitionZh.trim(),
        definition_en: definitionEn.trim() || undefined,
        example_zh: exampleZh.trim() || undefined,
        context: contextEdit.trim(),
        material_id: materialId,
        mastery: 0,
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  const keyMissing = (error ?? '').toLowerCase().includes('not configured');

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between shrink-0">
          <h2 className="text-base font-medium text-stone-900">加为生词</h2>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-700 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 overflow-y-auto">
          <div>
            <div className="text-xs text-stone-500 mb-1">选中</div>
            <div className="text-xl font-medium text-stone-900 break-words">{word}</div>
          </div>

          {loading && (
            <div className="text-sm text-stone-500 py-6 text-center animate-pulse">
              DeepSeek 查询中...
            </div>
          )}

          {error && (
            <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded p-3">
              <div>{error}</div>
              {keyMissing && (
                <Link
                  to="/settings"
                  onClick={onClose}
                  className="underline mt-1 inline-block"
                >
                  去设置 →
                </Link>
              )}
            </div>
          )}

          {!loading && !error && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Field label="原形" value={lemma} onChange={setLemma} />
                <Field label="词性" value={pos} onChange={setPos} />
                <Field label="音标" value={phonetic} onChange={setPhonetic} mono />
              </div>
              <FieldArea
                label="中文释义 *"
                value={definitionZh}
                onChange={setDefinitionZh}
                rows={2}
              />
              <FieldArea
                label="英文释义"
                value={definitionEn}
                onChange={setDefinitionEn}
                rows={2}
              />
              <FieldArea
                label="上下文(原句)"
                value={contextEdit}
                onChange={setContextEdit}
                rows={3}
              />
              <FieldArea
                label="原句中文翻译"
                value={exampleZh}
                onChange={setExampleZh}
                rows={2}
              />
            </>
          )}
        </div>

        <div className="px-6 py-3 border-t border-stone-200 flex justify-end gap-2 shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md border border-stone-200 text-sm hover:bg-stone-50"
          >
            取消
          </button>
          <button
            onClick={save}
            disabled={loading || saving || !!error}
            className="px-3 py-1.5 rounded-md bg-stone-900 text-white text-sm hover:bg-stone-700 disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <div className="text-xs text-stone-500 mb-1">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full bg-white border border-stone-200 rounded px-2 py-1 text-sm focus:outline-none focus:border-stone-400 ${mono ? 'font-mono' : ''}`}
      />
    </label>
  );
}

function FieldArea({
  label,
  value,
  onChange,
  rows,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows: number;
}) {
  return (
    <label className="block">
      <div className="text-xs text-stone-500 mb-1">{label}</div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="w-full bg-white border border-stone-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-stone-400 resize-y leading-relaxed"
      />
    </label>
  );
}
