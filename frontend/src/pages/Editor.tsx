import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { createMaterial, getMaterial, getMaterialMetadata, updateMaterial } from '../api';
import type { MaterialLanguage, MaterialMetadata, SourceType } from '../types';
import { LANGUAGE_OPTIONS, normalizeLanguage } from '../lib/languages';

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
  const [language, setLanguage] = useState<MaterialLanguage>('en');
  const [sourceType, setSourceType] = useState<SourceType>('youtube');
  const [sourceRef, setSourceRef] = useState('');
  const [text, setText] = useState('');
  const [notes, setNotes] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [stage, setStage] = useState<'idle' | 'uploading' | 'saving'>('idle');
  const [metadata, setMetadata] = useState<MaterialMetadata | null>(null);
  const [metadataStatus, setMetadataStatus] = useState<'idle' | 'loading' | 'detected' | 'unknown' | 'error'>('idle');
  const [metadataError, setMetadataError] = useState('');
  const [loaded, setLoaded] = useState(editingId == null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const titleTouchedRef = useRef(editingId != null);
  const metadataInputRef = useRef('');

  useEffect(() => {
    if (editingId == null) return;
    (async () => {
      const m = await getMaterial(editingId);
      if (!m) {
        navigate('/');
        return;
      }
      setTitle(m.title);
      setLanguage(normalizeLanguage(m.language));
      setSourceType(m.source_type);
      setSourceRef(m.source_ref);
      setText(m.text);
      setNotes(m.notes);
      setLoaded(true);
    })();
  }, [editingId, navigate]);

  useEffect(() => {
    if (sourceType === 'local') {
      setMetadata(null);
      setMetadataStatus('idle');
      setMetadataError('');
      metadataInputRef.current = '';
      return;
    }

    const raw = sourceRef.trim();
    if (!raw) {
      setMetadata(null);
      setMetadataStatus('idle');
      setMetadataError('');
      metadataInputRef.current = '';
      return;
    }
    if (metadataInputRef.current === raw && metadata) return;

    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setMetadataStatus('loading');
      setMetadataError('');
      try {
        const next = await getMaterialMetadata(raw);
        if (cancelled) return;
        setMetadata(next);
        metadataInputRef.current = raw;
        if (next.source_type) {
          if (next.source_type !== sourceType) setSourceType(next.source_type);
          setMetadataStatus('detected');
          if (!titleTouchedRef.current && next.title?.trim()) {
            setTitle(next.title.trim());
          }
        } else {
          setMetadataStatus('unknown');
        }
      } catch (e) {
        if (cancelled) return;
        const fallback = detectExternalSource(raw);
        if (fallback) {
          setMetadata(fallback);
          metadataInputRef.current = raw;
          if (fallback.source_type && fallback.source_type !== sourceType) {
            setSourceType(fallback.source_type);
          }
          setMetadataStatus('detected');
        } else {
          setMetadataStatus('error');
        }
        setMetadataError((e as Error).message);
      }
    }, 450);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [sourceRef, sourceType]);

  function pickLocalFile(file: File) {
    if (!isValidVideo(file)) {
      alert(`不支持的扩展名,请选 ${ALLOWED_EXTS.join(' / ')}`);
      return;
    }
    setSourceType('local');
    setMetadata(null);
    setMetadataStatus('idle');
    setMetadataError('');
    metadataInputRef.current = '';
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
    if (sourceType === 'local' && !pendingFile && !sourceRef) {
      alert('请选择本地视频文件');
      return;
    }
    if (sourceType !== 'local' && !sourceRef.trim()) {
      alert('请填写视频链接或视频 ID');
      return;
    }

    let finalSourceType = sourceType;
    let finalSourceRef = sourceRef.trim();
    let finalTitle = title.trim();
    try {
      if (sourceType === 'local' && pendingFile) {
        setStage('uploading');
        finalSourceRef = await uploadPending();
        finalTitle ||= pendingFile.name.replace(/\.[^.]+$/, '');
      } else if (sourceType !== 'local') {
        const cachedMetadata =
          metadataInputRef.current === finalSourceRef ? metadata : null;
        const detected = cachedMetadata?.source_type
          ? normalizeDetectedMetadata(cachedMetadata)
          : normalizeDetectedMetadata(await getMaterialMetadata(finalSourceRef));
        if (detected.source_type) {
          finalSourceType = detected.source_type;
          finalSourceRef = detected.source_ref;
          finalTitle ||= detected.title?.trim() ?? '';
        }
      }
      finalTitle ||= finalSourceRef;
      setStage('saving');
      if (editingId) {
        await updateMaterial(editingId, {
          title: finalTitle,
          language,
          source_type: finalSourceType,
          source_ref: finalSourceRef,
          text,
          notes,
        });
        navigate(`/m/${editingId}`);
      } else {
        const m = await createMaterial({
          title: finalTitle,
          language,
          source_type: finalSourceType,
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
      <main className="flex-1 overflow-y-auto"><div className="max-w-3xl mx-auto px-6 py-10 text-muted-foreground text-sm">加载中...</div></main>
    );
  }

  const buttonLabel =
    stage === 'uploading' ? '上传中...' :
    stage === 'saving' ? '保存中...' : '保存';

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-10 w-full">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-medium text-foreground tracking-tight">
          {editingId ? '编辑材料' : '新建材料'}
        </h1>
        <Link
          to={editingId ? `/m/${editingId}` : '/'}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          取消
        </Link>
      </div>

      <div className="space-y-7">
        <Field label="标题">
          <input
            value={title}
            onChange={(e) => {
              titleTouchedRef.current = true;
              setTitle(e.target.value);
            }}
            placeholder="例:TED - The Power of Vulnerability"
            className="w-full bg-card border border-border rounded-md px-3 py-2 text-[15px] focus:outline-none focus:border-border focus:ring-2 focus:ring-ring/30"
          />
        </Field>

        <Field label="学习语言">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {LANGUAGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setLanguage(option.value)}
                className={`rounded-md border px-3 py-2 text-left transition ${
                  language === option.value
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-border bg-card text-foreground/85 hover:border-border hover:bg-accent/50'
                }`}
              >
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {option.hint}
                </span>
              </button>
            ))}
          </div>
        </Field>

        <Field label="视频源">
          <div className="flex flex-wrap gap-2">
            {TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => {
                  setSourceType(t.value);
                  if (t.value === 'local') {
                    setMetadata(null);
                    setMetadataStatus('idle');
                    setMetadataError('');
                    metadataInputRef.current = '';
                  }
                }}
                className={`px-3 py-1.5 rounded-md border text-sm transition ${
                  sourceType === t.value
                    ? 'bg-success/10 text-success border-success/40'
                    : 'bg-card text-foreground/85 border-border hover:border-border'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
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
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-border hover:bg-accent/50'
                  }`}
                >
                  <div className="pointer-events-none">
                    <div className="text-sm font-medium text-foreground">
                      {isDragging ? '松手即放' : '拖入视频文件,或点此选择'}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
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
                  <div className="mt-3 flex items-center justify-between gap-3 bg-success/10 border border-success/30 rounded px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium text-foreground truncate">{pendingFile.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatSize(pendingFile.size)} · 保存时才上传
                        {sourceRef ? ' · 将替换原文件' : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPendingFile(null)}
                      className="text-xs text-muted-foreground hover:text-destructive shrink-0"
                    >
                      取消
                    </button>
                  </div>
                )}

                {!pendingFile && sourceRef && (
                  <p className="mt-3 text-xs text-muted-foreground break-all">
                    当前文件:backend/data/uploads/{sourceRef}
                  </p>
                )}
              </div>
            ) : (
              <input
                value={sourceRef}
                onChange={(e) => {
                  metadataInputRef.current = '';
                  setMetadata(null);
                  setMetadataStatus('idle');
                  setMetadataError('');
                  setSourceRef(e.target.value);
                }}
                placeholder={
                  sourceType === 'youtube'
                    ? 'https://www.youtube.com/watch?v=...'
                    : 'https://www.bilibili.com/video/BV...'
                }
                className="w-full bg-card border border-border rounded-md px-3 py-2 text-[15px] font-mono focus:outline-none focus:border-border focus:ring-2 focus:ring-ring/30"
              />
            )}
            {sourceType !== 'local' && (
              <MetadataHint
                status={metadataStatus}
                metadata={metadata}
                error={metadataError}
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
            className="w-full bg-card border border-border rounded-md px-3 py-2 text-[15px] focus:outline-none focus:border-border focus:ring-2 focus:ring-ring/30 resize-y leading-relaxed"
          />
          <p className="mt-1.5 text-xs text-muted-foreground/70">
            空行会被识别为段落分隔。
          </p>
        </Field>

        <Field label="备注(可选)">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="生词、句法、感想..."
            className="w-full bg-card border border-border rounded-md px-3 py-2 text-[15px] focus:outline-none focus:border-border focus:ring-2 focus:ring-ring/30 resize-y"
          />
        </Field>

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Link
            to={editingId ? `/m/${editingId}` : '/'}
            className="px-4 py-2 rounded-md border border-border text-sm text-foreground/85 hover:bg-accent/50"
          >
            取消
          </Link>
          <button
            disabled={stage !== 'idle'}
            onClick={save}
            className="px-4 py-2 rounded-md bg-foreground text-white text-sm hover:bg-foreground/85 disabled:opacity-50"
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
      <div className="text-sm font-medium text-foreground mb-2">{label}</div>
      {children}
    </div>
  );
}

function MetadataHint({
  status,
  metadata,
  error,
}: {
  status: 'idle' | 'loading' | 'detected' | 'unknown' | 'error';
  metadata: MaterialMetadata | null;
  error: string;
}) {
  if (status === 'idle') return null;
  if (status === 'loading') {
    return <p className="mt-2 text-xs text-muted-foreground">正在读取视频信息...</p>;
  }
  if (status === 'detected' && metadata?.source_type) {
    const label = metadata.source_type === 'youtube' ? 'YouTube' : 'Bilibili';
    return (
      <p className="mt-2 text-xs text-success">
        已识别为 {label}
        {metadata.title ? ` · 已读取标题: ${metadata.title}` : ' · 暂未读取到标题'}
        {metadata.bilibili?.page_count && metadata.bilibili.page_count > 1
          ? ` · 分P ${metadata.bilibili.page}/${metadata.bilibili.page_count}`
          : ''}
        {error ? ` · 后端标题读取未完成: ${error}` : ''}
      </p>
    );
  }
  if (status === 'unknown') {
    return (
      <p className="mt-2 text-xs text-primary">
        暂未识别来源,保存时会按当前选择的视频源处理。
      </p>
    );
  }
  return (
    <p className="mt-2 text-xs text-destructive">
      视频信息读取失败,仍可保存,但可能需要手动确认视频源。
    </p>
  );
}

function detectExternalSource(input: string): MaterialMetadata | null {
  const sourceRef = input.trim();
  const youtube = youtubeId(sourceRef);
  if (youtube) {
    return { source_type: 'youtube', source_ref: youtube, title: null };
  }
  const bilibili = bilibiliRef(sourceRef);
  if (bilibili) {
    return {
      source_type: 'bilibili',
      source_ref: formatBilibiliSourceRef(bilibili),
      title: null,
      bilibili: {
        bvid: bilibili.bvid,
        page: bilibili.page ?? 1,
        page_count: 1,
        aid: bilibili.aid,
        cid: bilibili.cid,
      },
    };
  }
  return null;
}

function normalizeDetectedMetadata(metadata: MaterialMetadata): MaterialMetadata {
  if (metadata.source_type !== 'bilibili' || !metadata.bilibili) {
    return metadata;
  }
  return {
    ...metadata,
    source_ref: formatBilibiliSourceRef({
      bvid: metadata.bilibili.bvid,
      page: metadata.bilibili.page,
      cid: metadata.bilibili.cid ?? undefined,
      aid: metadata.bilibili.aid ?? undefined,
    }),
  };
}

function youtubeId(input: string): string | null {
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (!isHostOrSubdomain(host, 'youtube.com') && !isHostOrSubdomain(host, 'youtube-nocookie.com')) {
      return null;
    }
    const queryId = url.searchParams.get('v');
    if (queryId && /^[\w-]{11}$/.test(queryId)) return queryId;
    const match = url.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{11})/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

interface BilibiliSourceRef {
  bvid: string;
  page?: number;
  cid?: number;
  aid?: number;
}

function bilibiliRef(input: string): BilibiliSourceRef | null {
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (!isHostOrSubdomain(host, 'bilibili.com')) return null;
    const bvid = findBvid(url.pathname) ?? url.searchParams.get('bvid');
    if (!bvid) return null;
    return {
      bvid,
      page: positiveInt(url.searchParams.get('p') ?? url.searchParams.get('page')),
      cid: positiveInt(url.searchParams.get('cid')),
      aid: positiveInt(url.searchParams.get('aid')),
    };
  } catch {
    const bvid = findBvid(input);
    if (!bvid) return null;
    const query = input.split('?', 2)[1] ?? '';
    const params = new URLSearchParams(query);
    return {
      bvid,
      page: positiveInt(params.get('p') ?? params.get('page')),
      cid: positiveInt(params.get('cid')),
      aid: positiveInt(params.get('aid')),
    };
  }
}

function findBvid(input: string): string | null {
  return input.match(/BV[a-zA-Z0-9]{8,}/)?.[0] ?? null;
}

function positiveInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function formatBilibiliSourceRef(ref: BilibiliSourceRef): string {
  const params = new URLSearchParams();
  if (ref.page && ref.page > 1) params.set('p', String(ref.page));
  if (ref.cid) params.set('cid', String(ref.cid));
  if (ref.aid) params.set('aid', String(ref.aid));
  const query = params.toString();
  return query ? `${ref.bvid}?${query}` : ref.bvid;
}

function isHostOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}
