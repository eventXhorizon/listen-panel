import { useEffect, useRef, useState } from 'react';
import { Loader2, ScanText, X, Clipboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import ProviderBadge from '../components/ProviderBadge';
import { recognizeImage, type RecognizeResult } from '../lib/llm';

type Status = 'idle' | 'loading' | 'ready';

const MAX_BYTES = 6 * 1024 * 1024; // ~6 MB raw image; matches backend cap.

/** Read a File/Blob into a `data:image/...;base64,...` URL. */
function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 识别页:把英文图片(截图/拍照)粘贴进来 → Gemini 一步 OCR + 翻译成中文。
 *  纯前端读图为 data URL,后端不落库。 */
export default function Recognize() {
  const [image, setImage] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<RecognizeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function acceptFile(file: Blob | undefined | null) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('请粘贴或选择图片文件');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('图片太大(超过 6 MB),请压缩后再试');
      return;
    }
    setError(null);
    setResult(null);
    setStatus('idle');
    try {
      setImage(await fileToDataUrl(file));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Listen for paste anywhere on the page so the user can just Cmd/Ctrl+V.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith('image/'),
      );
      if (item) {
        e.preventDefault();
        void acceptFile(item.getAsFile());
      }
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  async function onRecognize() {
    if (!image || status === 'loading') return;
    setError(null);
    setResult(null);
    setStatus('loading');
    try {
      const r = await recognizeImage(image);
      setResult(r);
      setStatus('ready');
    } catch (e) {
      setStatus('idle');
      setError((e as Error).message);
    }
  }

  function reset() {
    setImage(null);
    setResult(null);
    setError(null);
    setStatus('idle');
  }

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="mb-6 flex items-center gap-2">
          <ScanText className="size-5 text-muted-foreground" />
          <h1 className="text-2xl font-medium tracking-tight text-foreground">
            识别
          </h1>
        </div>
        <p className="mb-6 text-sm text-muted-foreground">
          截图或拍一张带英文的图片 → 直接 Ctrl/⌘+V 粘贴到下面 → 一键识别并翻译成中文。
          目前支持英文 → 中文。
        </p>

        {!image ? (
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void acceptFile(e.dataTransfer.files?.[0]);
            }}
            className={cn(
              'flex min-h-[220px] cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed text-center transition',
              dragOver
                ? 'border-primary bg-accent/50'
                : 'border-border bg-card hover:border-muted-foreground/40',
            )}
          >
            <Clipboard className="size-7 text-muted-foreground" />
            <div className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Ctrl/⌘ + V</span> 粘贴图片
              <br />
              也可以拖拽图片到这里,或点击选择文件
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="relative overflow-hidden rounded-lg border border-border bg-card">
              <img
                src={image}
                alt="待识别的图片"
                className="max-h-[420px] w-full object-contain"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={reset}
                title="移除图片"
                aria-label="移除图片"
                className="absolute right-2 top-2 bg-background/80 backdrop-blur"
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={onRecognize}
                disabled={status === 'loading'}
                className="min-w-[120px]"
              >
                {status === 'loading' ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    识别中
                  </>
                ) : (
                  <>
                    <ScanText className="size-4" />
                    识别并翻译
                  </>
                )}
              </Button>
              <Button variant="ghost" size="sm" onClick={reset}>
                换一张
              </Button>
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => void acceptFile(e.target.files?.[0])}
        />

        {error && (
          <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {result && status === 'ready' && (
          <div className="mt-6">
            {!result.source_text && !result.translation_zh ? (
              <p className="text-sm text-muted-foreground">
                没有在图片里识别到英文文字。
              </p>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                <ResultBlock title="识别原文" body={result.source_text} muted />
                <ResultBlock title="中文翻译" body={result.translation_zh} />
              </div>
            )}
            {result.provider && (
              <div className="mt-3">
                <ProviderBadge provider={result.provider} />
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function ResultBlock({
  title,
  body,
  muted = false,
}: {
  title: string;
  body: string;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card/50 p-4">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <div
        className={cn(
          'flex flex-col gap-2 whitespace-pre-wrap text-[15px] leading-7',
          muted ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {body || '—'}
      </div>
    </div>
  );
}
