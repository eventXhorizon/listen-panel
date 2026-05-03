import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { createMaterial, getMaterial, updateMaterial } from '../api';
import type { SourceType } from '../types';

const TYPES: { value: SourceType; label: string; hint: string }[] = [
  { value: 'youtube', label: 'YouTube', hint: '粘贴 YouTube 链接或 11 位视频 ID' },
  { value: 'bilibili', label: 'Bilibili', hint: '粘贴 Bilibili 视频链接或 BV 号' },
  { value: 'local', label: '本地文件', hint: '拖入或选择本地视频,点击保存时才会上传' },
];

const ALLOWED_EXTS = ['mp4', 'mkv', 'webm', 'mov', 'm4v'] as const;

function isValidVideo(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return (ALLOWED_EXTS as readonly string[]).includes(ext);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function Editor() {
  const { id } = useParams();
  const editingId = id ? Number(id) : null;
  const navigate = useNavigate();

  const [title, setTitle] = useState('');
  const [sourceType, setSourceType] = useState<SourceType>('youtube');
  const [sourceRef, setSourceRef] = useState('');
  const [text, setText] = useState('');
  const [notes, setNotes] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [stage, setStage] = useState<'idle' | 'uploading' | 'saving'>('idle');
  const [loaded, setLoaded] = useState(editingId == null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    if (editingId == null) return;
    (async () => {
      const m = await getMaterial(editingId);
      if (!m) {
        navigate('/');
        return;
      }
      setTitle(m.title);
      setSourceType(m.source_type);
      setSourceRef(m.source_ref);
      setText(m.text);
      setNotes(m.notes);
      setLoaded(true);
    })();
  }, [editingId, navigate]);

  function pickLocalFile(file: File) {
    if (!isValidVideo(file)) {
      alert(`不支持的扩展名,请选 ${ALLOWED_EXTS.join(' / ')}`);
      return;
    }
    setSourceType('local');
    setPendingFile(file);
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
  }

  function onDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragging(true);
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) pickLocalFile(file);
  }

  async function uploadPending(): Promise<string> {
    const fd = new FormData();
    fd.append('file', pendingFile!);
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: fd,
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? res.statusText);
    }
    const { file: name } = (await res.json()) as { file: string };
    return name;
  }

  async function save() {
    if (!title.trim()) {
      alert('请填写标题');
      return;
    }
    if (sourceType === 'local' && !pendingFile && !sourceRef) {
      alert('请选择本地视频文件');
      return;
    }

    let finalSourceRef = sourceRef.trim();
    try {
      if (sourceType === 'local' && pendingFile) {
        setStage('uploading');
        finalSourceRef = await uploadPending();
      }
      setStage('saving');
      if (editingId) {
        await updateMaterial(editingId, {
          title: title.trim(),
          source_type: sourceType,
          source_ref: finalSourceRef,
          text,
          notes,
        });
        navigate(`/m/${editingId}`);
      } else {
        const m = await createMaterial({
          title: title.trim(),
          source_type: sourceType,
          source_ref: finalSourceRef,
          text,
          notes,
        });
        navigate(`/m/${m.id}`);
      }
    } catch (e) {
      alert(`保存失败: ${(e as Error).message}`);
    } finally {
      setStage('idle');
    }
  }

  if (!loaded) {
    return (
      <main className="flex-1 overflow-y-auto"><div className="max-w-3xl mx-auto px-6 py-10 text-stone-500 text-sm">加载中...</div></main>
    );
  }

  const buttonLabel =
    stage === 'uploading' ? '上传中...' :
    stage === 'saving' ? '保存中...' : '保存';

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-10 w-full">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-medium text-stone-900 tracking-tight">
          {editingId ? '编辑材料' : '新建材料'}
        </h1>
        <Link
          to={editingId ? `/m/${editingId}` : '/'}
          className="text-sm text-stone-500 hover:text-stone-900"
        >
          取消
        </Link>
      </div>

      <div className="space-y-7">
        <Field label="标题">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例:TED - The Power of Vulnerability"
            className="w-full bg-white border border-stone-200 rounded-md px-3 py-2 text-[15px] focus:outline-none focus:border-stone-400 focus:ring-2 focus:ring-stone-100"
          />
        </Field>

        <Field label="视频源">
          <div className="flex flex-wrap gap-2">
            {TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setSourceType(t.value)}
                className={`px-3 py-1.5 rounded-md border text-sm transition ${
                  sourceType === t.value
                    ? 'bg-stone-900 text-white border-stone-900'
                    : 'bg-white text-stone-700 border-stone-200 hover:border-stone-400'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-stone-500">
            {TYPES.find((t) => t.value === sourceType)?.hint}
          </p>

          <div className="mt-3">
            {sourceType === 'local' ? (
              <div>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragEnter={onDragEnter}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onDrop={onDrop}
                  className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition select-none ${
                    isDragging
                      ? 'border-stone-900 bg-stone-50'
                      : 'border-stone-300 hover:border-stone-400 hover:bg-stone-50'
                  }`}
                >
                  <div className="pointer-events-none">
                    <div className="text-sm font-medium text-stone-800">
                      {isDragging ? '松手即放' : '拖入视频文件,或点此选择'}
                    </div>
                    <div className="text-xs text-stone-500 mt-1">
                      支持 {ALLOWED_EXTS.join(' / ')}
                    </div>
                  </div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) pickLocalFile(f);
                    e.target.value = '';
                  }}
                />

                {pendingFile && (
                  <div className="mt-3 flex items-center justify-between gap-3 bg-emerald-50 border border-emerald-200 rounded px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium text-stone-900 truncate">{pendingFile.name}</div>
                      <div className="text-xs text-stone-500">
                        {formatSize(pendingFile.size)} · 保存时才上传
                        {sourceRef ? ' · 将替换原文件' : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPendingFile(null)}
                      className="text-xs text-stone-500 hover:text-rose-600 shrink-0"
                    >
                      取消
                    </button>
                  </div>
                )}

                {!pendingFile && sourceRef && (
                  <p className="mt-3 text-xs text-stone-500 break-all">
                    当前文件:backend/data/uploads/{sourceRef}
                  </p>
                )}
              </div>
            ) : (
              <input
                value={sourceRef}
                onChange={(e) => setSourceRef(e.target.value)}
                placeholder={
                  sourceType === 'youtube'
                    ? 'https://www.youtube.com/watch?v=...'
                    : 'https://www.bilibili.com/video/BV...'
                }
                className="w-full bg-white border border-stone-200 rounded-md px-3 py-2 text-[15px] font-mono focus:outline-none focus:border-stone-400 focus:ring-2 focus:ring-stone-100"
              />
            )}
          </div>
        </Field>

        <Field label="原文全文">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={14}
            placeholder="把听力原文粘贴到这里..."
            className="w-full bg-white border border-stone-200 rounded-md px-3 py-2 text-[15px] focus:outline-none focus:border-stone-400 focus:ring-2 focus:ring-stone-100 resize-y leading-relaxed"
          />
          <p className="mt-1.5 text-xs text-stone-400">
            空行会被识别为段落分隔。
          </p>
        </Field>

        <Field label="备注(可选)">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="生词、句法、感想..."
            className="w-full bg-white border border-stone-200 rounded-md px-3 py-2 text-[15px] focus:outline-none focus:border-stone-400 focus:ring-2 focus:ring-stone-100 resize-y"
          />
        </Field>

        <div className="flex justify-end gap-2 pt-2 border-t border-stone-200">
          <Link
            to={editingId ? `/m/${editingId}` : '/'}
            className="px-4 py-2 rounded-md border border-stone-200 text-sm text-stone-700 hover:bg-stone-50"
          >
            取消
          </Link>
          <button
            disabled={stage !== 'idle'}
            onClick={save}
            className="px-4 py-2 rounded-md bg-stone-900 text-white text-sm hover:bg-stone-700 disabled:opacity-50"
          >
            {buttonLabel}
          </button>
        </div>
      </div>
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm font-medium text-stone-800 mb-2">{label}</div>
      {children}
    </div>
  );
}
