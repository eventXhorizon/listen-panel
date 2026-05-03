import { useEffect, useState, useRef, useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getMaterial, listVocab } from '../api';
import type { Material, VocabEntry } from '../types';
import VideoPlayer from '../components/VideoPlayer';
import SelectionPopup from '../components/SelectionPopup';
import AddVocabDialog from '../components/AddVocabDialog';
import VocabPanel from '../components/VocabPanel';
import { findSentence } from '../lib/sentence';
import { highlightText } from '../lib/highlight';

interface PendingAdd {
  word: string;
  context: string;
}

export default function Reader() {
  const { id } = useParams();
  const mid = Number(id);
  const navigate = useNavigate();
  const [m, setM] = useState<Material | null>(null);
  const [vocab, setVocab] = useState<VocabEntry[]>([]);
  const [leftPct, setLeftPct] = useState(50);
  const [highlightOn, setHighlightOn] = useState(true);
  const [pending, setPending] = useState<PendingAdd | null>(null);
  const [showVocabPanel, setShowVocabPanel] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (Number.isNaN(mid)) {
      navigate('/');
      return;
    }
    (async () => {
      const data = await getMaterial(mid);
      if (!data) {
        navigate('/');
        return;
      }
      setM(data);
      setVocab(await listVocab(mid));
    })();
  }, [mid, navigate]);

  async function refreshVocab() {
    setVocab(await listVocab(mid));
  }

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    draggingRef.current = true;
    e.preventDefault();
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.max(28, Math.min(78, pct)));
    }
    function onUp() {
      draggingRef.current = false;
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  function handleAddFromSelection(text: string) {
    if (!m) return;
    const sel = window.getSelection();
    let context = '';
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const startNode = range.startContainer;
      const paraEl = (
        startNode.nodeType === Node.TEXT_NODE
          ? startNode.parentElement
          : (startNode as Element)
      )?.closest('[data-paragraph]') as HTMLElement | null;
      if (paraEl) {
        const paraIdx = Number(paraEl.dataset.paragraph);
        const paragraphs = (m.text || '')
          .split(/\n{2,}/)
          .map((p) => p.trim())
          .filter(Boolean);
        const para = paragraphs[paraIdx] ?? '';
        const offset = para.toLowerCase().indexOf(text.toLowerCase());
        context = offset >= 0 ? findSentence(para, offset) : para;
      }
    }
    setPending({ word: text, context: context || text });
  }

  if (!m) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-10 text-stone-500 text-sm">
          加载中...
        </div>
      </main>
    );
  }

  const paragraphs = m.text
    ? m.text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
    : [];

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b border-stone-200 bg-white">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="min-w-0">
            <Link
              to="/"
              className="text-xs text-stone-500 hover:text-stone-900"
            >
              ← 返回书架
            </Link>
            <h1 className="text-lg font-medium text-stone-900 mt-0.5 truncate">
              {m.title}
            </h1>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-4">
            <label className="flex items-center gap-1.5 text-xs text-stone-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={highlightOn}
                onChange={(e) => setHighlightOn(e.target.checked)}
              />
              高亮生词
            </label>
            <button
              onClick={() => setShowVocabPanel(true)}
              className="text-xs px-2.5 py-1 rounded border border-stone-200 text-stone-700 hover:bg-stone-50"
            >
              生词 ({vocab.length})
            </button>
            <span className="text-xs text-stone-500 hidden md:inline">
              {Math.round(leftPct)} / {Math.round(100 - leftPct)}
            </span>
            <button
              onClick={() => setLeftPct(50)}
              className="text-xs px-2 py-1 rounded border border-stone-200 text-stone-600 hover:bg-stone-50"
              title="重置分栏比例"
            >
              均分
            </button>
            <Link
              to={`/m/${m.id}/edit`}
              className="text-sm px-3 py-1.5 rounded-md border border-stone-200 hover:bg-stone-50"
            >
              编辑
            </Link>
          </div>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 flex overflow-hidden min-h-0"
      >
        <div
          className="overflow-y-auto bg-white"
          style={{ width: `${leftPct}%` }}
        >
          <article
            ref={articleRef}
            className="px-10 py-10 max-w-2xl mx-auto"
          >
            {paragraphs.length > 0 ? (
              paragraphs.map((p, i) => (
                <p
                  key={i}
                  data-paragraph={i}
                  className="mb-5 text-stone-800 leading-[1.85] text-[17px] tracking-[0.01em]"
                >
                  {highlightOn ? highlightText(p, vocab) : p}
                </p>
              ))
            ) : (
              <p className="text-stone-400 italic">
                尚无原文。
                <Link
                  to={`/m/${m.id}/edit`}
                  className="underline ml-1"
                >
                  点此添加
                </Link>
              </p>
            )}
            {m.notes && (
              <div className="mt-12 pt-6 border-t border-stone-200">
                <h3 className="text-xs uppercase tracking-wider text-stone-500 mb-3">
                  备注
                </h3>
                <p className="text-stone-600 leading-relaxed whitespace-pre-wrap text-[15px]">
                  {m.notes}
                </p>
              </div>
            )}
          </article>
        </div>

        <div
          onMouseDown={onMouseDown}
          className="w-1 bg-stone-200 hover:bg-stone-400 active:bg-stone-500 cursor-col-resize transition shrink-0"
        />

        <div
          className="bg-stone-900 flex flex-col"
          style={{ width: `${100 - leftPct}%` }}
        >
          <div className="flex-1 min-h-0">
            <VideoPlayer
              sourceType={m.source_type}
              sourceRef={m.source_ref}
            />
          </div>
        </div>
      </div>

      <SelectionPopup
        containerRef={articleRef}
        onAdd={handleAddFromSelection}
      />

      {pending && (
        <AddVocabDialog
          word={pending.word}
          context={pending.context}
          materialId={mid}
          onClose={() => setPending(null)}
          onSaved={() => {
            setPending(null);
            refreshVocab();
          }}
        />
      )}

      {showVocabPanel && (
        <VocabPanel
          items={vocab}
          onClose={() => setShowVocabPanel(false)}
          onChange={refreshVocab}
        />
      )}
    </div>
  );
}
