import { useEffect, useState } from 'react';
import { checkAsrHealth } from '../api';
import { useAuth } from '../lib/auth-context';
import { loadSettings, saveSettings } from '../lib/settings';
import type {
  AsrHealthCheckStatus,
  AsrStatus,
  DataDirStatus,
  LlmStatus,
  TtsStatus,
  WorkerEndpointProbe,
} from '../types';

export default function Settings() {
  const auth = useAuth();
  const initial = loadSettings();
  const [volume, setVolume] = useState(initial.default_volume);

  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [show, setShow] = useState(false);
  const [ttsStatus, setTtsStatus] = useState<TtsStatus | null>(null);
  const [ttsApiKey, setTtsApiKey] = useState('');
  const [ttsRegion, setTtsRegion] = useState('');
  const [ttsVoiceIdEn, setTtsVoiceIdEn] = useState('');
  const [ttsVoiceIdJa, setTtsVoiceIdJa] = useState('');
  const [ttsOutputFormat, setTtsOutputFormat] = useState('');
  const [showTtsKey, setShowTtsKey] = useState(false);
  const [asrStatus, setAsrStatus] = useState<AsrStatus | null>(null);
  const [asrBaseUrl, setAsrBaseUrl] = useState('');
  const [asrToken, setAsrToken] = useState('');
  const [asrBackendBaseUrl, setAsrBackendBaseUrl] = useState('');
  const [asrModel, setAsrModel] = useState('');
  const [asrLanguage, setAsrLanguage] = useState('');
  const [asrBeamSize, setAsrBeamSize] = useState(5);
  const [asrVadFilter, setAsrVadFilter] = useState(true);
  const [asrConditionPrevious, setAsrConditionPrevious] = useState(false);
  const [asrHighAccuracy, setAsrHighAccuracy] = useState(true);
  const [asrTimeoutSeconds, setAsrTimeoutSeconds] = useState(7200);
  const [showAsrToken, setShowAsrToken] = useState(false);
  const [dataDirStatus, setDataDirStatus] = useState<DataDirStatus | null>(null);
  const [dataDir, setDataDir] = useState('');
  const [asrHealth, setAsrHealth] = useState<AsrHealthCheckStatus | null>(null);
  const [checkingAsrHealth, setCheckingAsrHealth] = useState(false);
  const [asrHealthErr, setAsrHealthErr] = useState<string | null>(null);

  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [ttsLoadErr, setTtsLoadErr] = useState<string | null>(null);
  const [asrLoadErr, setAsrLoadErr] = useState<string | null>(null);
  const [dataDirLoadErr, setDataDirLoadErr] = useState<string | null>(null);

  useEffect(() => {
    if (!auth.user?.is_admin) return;
    (async () => {
      try {
        const res = await fetch('/api/settings/llm', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const s = (await res.json()) as LlmStatus;
        setStatus(s);
        setBaseUrl(s.base_url);
        setModel(s.model);
      } catch (e) {
        setLoadErr((e as Error).message);
      }
    })();
  }, [auth.user?.is_admin]);

  useEffect(() => {
    if (!auth.user?.is_admin) return;
    (async () => {
      try {
        const res = await fetch('/api/settings/asr', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const s = (await res.json()) as AsrStatus;
        setAsrStatus(s);
        setAsrBaseUrl(s.base_url);
        setAsrBackendBaseUrl(s.backend_base_url);
        setAsrModel(s.model);
        setAsrLanguage(s.language);
        setAsrBeamSize(s.beam_size);
        setAsrVadFilter(s.vad_filter);
        setAsrConditionPrevious(s.condition_on_previous_text);
        setAsrHighAccuracy(s.high_accuracy);
        setAsrTimeoutSeconds(s.timeout_seconds);
      } catch (e) {
        setAsrLoadErr((e as Error).message);
      }
    })();
  }, [auth.user?.is_admin]);

  useEffect(() => {
    if (!auth.user?.is_admin) return;
    (async () => {
      try {
        const res = await fetch('/api/settings/tts', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const s = (await res.json()) as TtsStatus;
        setTtsStatus(s);
        setTtsRegion(s.region);
        setTtsVoiceIdEn(s.voice_id_en);
        setTtsVoiceIdJa(s.voice_id_ja);
        setTtsOutputFormat(s.output_format);
      } catch (e) {
        setTtsLoadErr((e as Error).message);
      }
    })();
  }, [auth.user?.is_admin]);

  useEffect(() => {
    if (!auth.user?.is_admin) return;
    (async () => {
      try {
        const res = await fetch('/api/settings/data-dir', {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const s = (await res.json()) as DataDirStatus;
        setDataDirStatus(s);
        setDataDir(s.pending_dir ?? s.configured_dir ?? s.active_dir);
      } catch (e) {
        setDataDirLoadErr((e as Error).message);
      }
    })();
  }, [auth.user?.is_admin]);

  async function onSave() {
    setSaving(true);
    try {
      // 1. local — volume
      saveSettings({ default_volume: Math.max(0, Math.min(1, volume)) });

      // 2. backend — only PUT what changed
      const patch: Record<string, string> = {};
      if (apiKey.trim()) patch.api_key = apiKey.trim();
      if (status && baseUrl.trim() && baseUrl.trim() !== status.base_url) {
        patch.base_url = baseUrl.trim();
      }
      if (status && model.trim() && model.trim() !== status.model) {
        patch.model = model.trim();
      }

      if (Object.keys(patch).length > 0) {
        const res = await fetch('/api/settings/llm', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const s = (await res.json()) as LlmStatus;
        setStatus(s);
        setApiKey('');
      }

      const ttsPatch: Record<string, string> = {};
      if (ttsApiKey.trim()) ttsPatch.api_key = ttsApiKey.trim();
      if (
        ttsStatus &&
        ttsRegion.trim() &&
        ttsRegion.trim() !== ttsStatus.region
      ) {
        ttsPatch.region = ttsRegion.trim();
      }
      if (
        ttsStatus &&
        ttsVoiceIdEn.trim() &&
        ttsVoiceIdEn.trim() !== ttsStatus.voice_id_en
      ) {
        ttsPatch.voice_id_en = ttsVoiceIdEn.trim();
      }
      if (
        ttsStatus &&
        ttsVoiceIdJa.trim() &&
        ttsVoiceIdJa.trim() !== ttsStatus.voice_id_ja
      ) {
        ttsPatch.voice_id_ja = ttsVoiceIdJa.trim();
      }
      if (
        ttsStatus &&
        ttsOutputFormat.trim() &&
        ttsOutputFormat.trim() !== ttsStatus.output_format
      ) {
        ttsPatch.output_format = ttsOutputFormat.trim();
      }

      if (Object.keys(ttsPatch).length > 0) {
        const res = await fetch('/api/settings/tts', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ttsPatch),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const s = (await res.json()) as TtsStatus;
        setTtsStatus(s);
        setTtsApiKey('');
      }

      const asrPatch: Record<string, string | number | boolean> = {};
      if (asrToken.trim()) asrPatch.api_token = asrToken.trim();
      if (
        asrStatus &&
        asrBaseUrl.trim() &&
        asrBaseUrl.trim() !== asrStatus.base_url
      ) {
        asrPatch.base_url = asrBaseUrl.trim();
      }
      if (
        asrStatus &&
        asrBackendBaseUrl.trim() &&
        asrBackendBaseUrl.trim() !== asrStatus.backend_base_url
      ) {
        asrPatch.backend_base_url = asrBackendBaseUrl.trim();
      }
      if (asrStatus && asrModel.trim() && asrModel.trim() !== asrStatus.model) {
        asrPatch.model = asrModel.trim();
      }
      if (
        asrStatus &&
        asrLanguage.trim() &&
        asrLanguage.trim() !== asrStatus.language
      ) {
        asrPatch.language = asrLanguage.trim();
      }
      if (asrStatus && asrBeamSize !== asrStatus.beam_size) {
        asrPatch.beam_size = asrBeamSize;
      }
      if (asrStatus && asrVadFilter !== asrStatus.vad_filter) {
        asrPatch.vad_filter = asrVadFilter;
      }
      if (
        asrStatus &&
        asrConditionPrevious !== asrStatus.condition_on_previous_text
      ) {
        asrPatch.condition_on_previous_text = asrConditionPrevious;
      }
      if (asrStatus && asrHighAccuracy !== asrStatus.high_accuracy) {
        asrPatch.high_accuracy = asrHighAccuracy;
      }
      if (asrStatus && asrTimeoutSeconds !== asrStatus.timeout_seconds) {
        asrPatch.timeout_seconds = asrTimeoutSeconds;
      }

      if (Object.keys(asrPatch).length > 0) {
        const res = await fetch('/api/settings/asr', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(asrPatch),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const s = (await res.json()) as AsrStatus;
        setAsrStatus(s);
        setAsrToken('');
      }

      if (dataDirStatus && dataDirStatus.source !== 'env') {
        const trimmed = dataDir.trim();
        const current =
          dataDirStatus.pending_dir ??
          dataDirStatus.configured_dir ??
          dataDirStatus.active_dir;
        if (trimmed && trimmed !== current) {
          const res = await fetch('/api/settings/data-dir', {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data_dir: trimmed }),
          });
          if (!res.ok) {
            const err = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(err.error ?? `HTTP ${res.status}`);
          }
          const s = (await res.json()) as DataDirStatus;
          setDataDirStatus(s);
          setDataDir(s.pending_dir ?? s.configured_dir ?? s.active_dir);
        }
      }

      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      alert(`保存失败:${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function onCheckAsrHealth() {
    setCheckingAsrHealth(true);
    setAsrHealthErr(null);
    try {
      const result = await checkAsrHealth({
        base_url: asrBaseUrl.trim(),
        api_token: asrToken.trim() || undefined,
      });
      setAsrHealth(result);
    } catch (e) {
      setAsrHealthErr((e as Error).message);
    } finally {
      setCheckingAsrHealth(false);
    }
  }

  const keyPlaceholder = status?.configured
    ? '已配置 ●●●●●● (留空保留现有 key)'
    : 'sk-...';
  const ttsKeyPlaceholder = ttsStatus?.configured
    ? '已配置 ●●●●●● (留空保留现有 key)'
    : 'sk_...';
  const asrTokenPlaceholder = asrStatus?.token_configured
    ? '已配置 ●●●●●● (留空保留现有 token)'
    : '可选 shared token';
  const dataDirLocked = dataDirStatus?.source === 'env';

  if (!auth.user?.is_admin) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-10 w-full">
          <h1 className="text-2xl font-medium text-foreground tracking-tight mb-2">
            设置
          </h1>
          <p className="text-sm text-muted-foreground">
            只有管理员可以查看和修改 DeepSeek / Azure Speech 凭据。
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-10 w-full">
        <h1 className="text-2xl font-medium text-foreground tracking-tight mb-2">
          设置
        </h1>
        <p className="text-sm text-muted-foreground mb-8">
          DeepSeek、TTS、ASR 凭据和本地数据保存在数据目录中,不会回传 API key。本地音量存浏览器 localStorage。
        </p>

        <div className="space-y-7">
          <section className="bg-card border border-border rounded-lg p-5">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="text-sm font-medium text-foreground">数据存储</h2>
              {dataDirLoadErr ? (
                <span className="text-xs px-2 py-0.5 rounded bg-destructive/5 text-destructive border border-destructive/30">
                  后端不可达 · {dataDirLoadErr}
                </span>
              ) : dataDirStatus ? (
                <span className="text-xs px-2 py-0.5 rounded bg-accent text-muted-foreground border border-border">
                  {dataDirSourceLabel(dataDirStatus.source)}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground/70">读取中...</span>
              )}
            </div>

            <div className="space-y-5">
              <Field label="当前使用目录">
                <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs font-mono text-foreground/85 break-all">
                  {dataDirStatus?.active_dir ?? '读取中...'}
                </div>
              </Field>

              <Field label="重启后使用目录">
                <input
                  value={dataDir}
                  onChange={(e) => setDataDir(e.target.value)}
                  disabled={dataDirLocked}
                  placeholder="/Users/you/listen-panel-data"
                  className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-border disabled:bg-muted/50 disabled:text-muted-foreground/70"
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  这里是整个本机服务的数据目录,包含 SQLite、生词、文章、上传视频、TTS 缓存和凭据。修改后需要重启服务才会生效;旧数据不会自动搬迁。
                </p>
                {dataDirLocked && (
                  <p className="mt-2 text-xs text-primary">
                    当前由 LISTEN_PANEL_DATA_DIR 环境变量指定,设置页不能覆盖。
                  </p>
                )}
                {dataDirStatus?.restart_required && (
                  <p className="mt-2 text-xs text-primary">
                    已保存新的目录,重启后才会切换。
                  </p>
                )}
              </Field>
            </div>
          </section>

          <section className="bg-card border border-border rounded-lg p-5">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="text-sm font-medium text-foreground">DeepSeek</h2>
              <StatusBadge status={status} loadErr={loadErr} />
            </div>

            <div className="space-y-5">
              <Field label="API Key">
                <div className="flex gap-2">
                  <input
                    type={show ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={keyPlaceholder}
                    className="flex-1 bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-border"
                  />
                  <button
                    type="button"
                    onClick={() => setShow((s) => !s)}
                    className="px-3 py-2 rounded-md border border-border text-xs hover:bg-accent/50"
                  >
                    {show ? '隐藏' : '显示'}
                  </button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  申请地址:
                  <a
                    href="https://platform.deepseek.com/api_keys"
                    target="_blank"
                    rel="noreferrer"
                    className="underline ml-1"
                  >
                    platform.deepseek.com/api_keys
                  </a>
                </p>
              </Field>

              <Field label="Base URL">
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.deepseek.com"
                  className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-border"
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  兼容 OpenAI 协议的代理(SiliconFlow / DashScope 等)在这里改。
                </p>
              </Field>

              <Field label="模型">
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="deepseek-chat"
                  className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-border"
                />
              </Field>
            </div>
          </section>

          <section className="bg-card border border-border rounded-lg p-5">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="text-sm font-medium text-foreground">Azure Speech TTS</h2>
              <StatusBadge status={ttsStatus} loadErr={ttsLoadErr} />
            </div>

            <div className="space-y-5">
              <Field label="API Key">
                <div className="flex gap-2">
                  <input
                    type={showTtsKey ? 'text' : 'password'}
                    value={ttsApiKey}
                    onChange={(e) => setTtsApiKey(e.target.value)}
                    placeholder={ttsKeyPlaceholder}
                    className="flex-1 bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-border"
                  />
                  <button
                    type="button"
                    onClick={() => setShowTtsKey((s) => !s)}
                    className="px-3 py-2 rounded-md border border-border text-xs hover:bg-accent/50"
                  >
                    {showTtsKey ? '隐藏' : '显示'}
                  </button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  申请地址:
                  <a
                    href="https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices"
                    target="_blank"
                    rel="noreferrer"
                    className="underline ml-1"
                  >
                    Azure Portal → 创建语音服务
                  </a>
                </p>
              </Field>

              <Field label="Azure Region">
                <input
                  value={ttsRegion}
                  onChange={(e) => setTtsRegion(e.target.value)}
                  placeholder="eastus"
                  className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-border"
                />
              </Field>

              <Field label="英语音色">
                <input
                  value={ttsVoiceIdEn}
                  onChange={(e) => setTtsVoiceIdEn(e.target.value)}
                  placeholder="en-US-AriaNeural"
                  className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-border"
                />
              </Field>

              <Field label="日语音色">
                <input
                  value={ttsVoiceIdJa}
                  onChange={(e) => setTtsVoiceIdJa(e.target.value)}
                  placeholder="ja-JP-NanamiNeural"
                  className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-border"
                />
              </Field>

              <Field label="输出格式">
                <input
                  value={ttsOutputFormat}
                  onChange={(e) => setTtsOutputFormat(e.target.value)}
                  placeholder="audio-48khz-192kbitrate-mono-mp3"
                  className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-border"
                />
              </Field>
            </div>
          </section>

          <section className="bg-card border border-border rounded-lg p-5">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="text-sm font-medium text-foreground">远程 ASR Worker</h2>
              <StatusBadge status={asrStatus} loadErr={asrLoadErr} />
            </div>

            <div className="space-y-5">
              <Field label="Worker Base URL">
                <input
                  value={asrBaseUrl}
                  onChange={(e) => setAsrBaseUrl(e.target.value)}
                  placeholder="http://192.168.0.50:8765"
                  className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-border"
                />
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={onCheckAsrHealth}
                    disabled={checkingAsrHealth || !asrBaseUrl.trim()}
                    className="inline-flex h-8 items-center rounded-md border border-primary/30 bg-primary/10 px-3 text-xs font-medium text-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:border-border disabled:bg-accent disabled:text-muted-foreground/70"
                  >
                    {checkingAsrHealth ? '检查中...' : '健康检查'}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    从 listen-panel 后端访问 worker,适合验证公网/隧道地址。
                  </span>
                </div>
                {(asrHealth || asrHealthErr) && (
                  <AsrHealthResult result={asrHealth} error={asrHealthErr} />
                )}
              </Field>

              <Field label="Backend Base URL">
                <input
                  value={asrBackendBaseUrl}
                  onChange={(e) => setAsrBackendBaseUrl(e.target.value)}
                  placeholder="http://192.168.0.113:9527"
                  className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-border"
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  GPU 机器用这个地址回连本机后端读取本地视频。
                </p>
              </Field>

              <Field label="Shared Token">
                <div className="flex gap-2">
                  <input
                    type={showAsrToken ? 'text' : 'password'}
                    value={asrToken}
                    onChange={(e) => setAsrToken(e.target.value)}
                    placeholder={asrTokenPlaceholder}
                    className="flex-1 bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-border"
                  />
                  <button
                    type="button"
                    onClick={() => setShowAsrToken((s) => !s)}
                    className="px-3 py-2 rounded-md border border-border text-xs hover:bg-accent/50"
                  >
                    {showAsrToken ? '隐藏' : '显示'}
                  </button>
                </div>
              </Field>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="模型">
                  <input
                    value={asrModel}
                    onChange={(e) => setAsrModel(e.target.value)}
                    placeholder="large-v3"
                    className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-border"
                  />
                </Field>
                <Field label="语言">
                  <input
                    value={asrLanguage}
                    onChange={(e) => setAsrLanguage(e.target.value)}
                    placeholder="en"
                    className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-border"
                  />
                </Field>
                <Field label="Beam Size">
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={asrBeamSize}
                    onChange={(e) => setAsrBeamSize(Number(e.target.value))}
                    className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-border"
                  />
                </Field>
                <Field label="超时秒数">
                  <input
                    type="number"
                    min={60}
                    value={asrTimeoutSeconds}
                    onChange={(e) => setAsrTimeoutSeconds(Number(e.target.value))}
                    className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-border"
                  />
                </Field>
              </div>

              <label className="flex items-center gap-2 text-sm text-foreground/85">
                <input
                  type="checkbox"
                  checked={asrVadFilter}
                  onChange={(e) => setAsrVadFilter(e.target.checked)}
                />
                VAD 静音过滤
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground/85">
                <input
                  type="checkbox"
                  checked={asrConditionPrevious}
                  onChange={(e) => setAsrConditionPrevious(e.target.checked)}
                />
                condition_on_previous_text
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground/85">
                <input
                  type="checkbox"
                  checked={asrHighAccuracy}
                  onChange={(e) => setAsrHighAccuracy(e.target.checked)}
                />
                高精度慢速模式
              </label>
            </div>
          </section>

          <section className="bg-card border border-border rounded-lg p-5">
            <h2 className="text-sm font-medium text-foreground mb-4">播放</h2>
            <Field label="本地视频默认音量">
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                  className="flex-1 accent-primary"
                />
                <span className="text-sm text-foreground/85 font-mono w-12 text-right tabular-nums">
                  {Math.round(volume * 100)}%
                </span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Reader 起播时本地视频用这个值,播放过程中调整也会写回。YouTube/Bilibili 走自己的播放器。
              </p>
            </Field>
          </section>

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={onSave}
              disabled={saving}
              className="px-4 py-2 rounded-md bg-foreground text-white text-sm hover:bg-foreground/85 disabled:opacity-50"
            >
              {saving ? '保存中...' : '保存'}
            </button>
            {savedAt && (
              <span className="text-xs text-muted-foreground">已保存 · {savedAt}</span>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function StatusBadge({
  status,
  loadErr,
}: {
  status: LlmStatus | null;
  loadErr: string | null;
}) {
  if (loadErr) {
    return (
      <span className="text-xs px-2 py-0.5 rounded bg-destructive/5 text-destructive border border-destructive/30">
        后端不可达 · {loadErr}
      </span>
    );
  }
  if (!status) {
    return <span className="text-xs text-muted-foreground/70">读取中...</span>;
  }
  if (status.configured) {
    return (
      <span className="text-xs px-2 py-0.5 rounded bg-success/10 text-success border border-success/30">
        ● 已配置
      </span>
    );
  }
  return (
    <span className="text-xs px-2 py-0.5 rounded bg-accent text-muted-foreground border border-border">
      ○ 未配置
    </span>
  );
}

function AsrHealthResult({
  result,
  error,
}: {
  result: AsrHealthCheckStatus | null;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        健康检查失败: {error}
      </div>
    );
  }
  if (!result) return null;

  return (
    <div
      className={`mt-3 rounded-md border px-3 py-3 text-xs ${
        result.ok
          ? 'border-success/30 bg-success/10 text-success'
          : 'border-primary/30 bg-primary/10 text-primary'
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium">
          {result.ok ? 'GPU Worker 可达' : 'GPU Worker 未完全可达'}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {new Date(result.checked_at).toLocaleTimeString()}
        </span>
      </div>
      <div className="space-y-1.5 text-foreground/85">
        <EndpointProbe label="/health" probe={result.health} />
        <EndpointProbe label="/v1/capabilities" probe={result.capabilities} />
      </div>
      {result.worker && (
        <div className="mt-3 grid grid-cols-1 gap-1.5 border-t border-current/10 pt-3 text-foreground/85 sm:grid-cols-2">
          <InfoLine label="Service" value={result.worker.service} />
          <InfoLine label="Version" value={result.worker.version} />
          <InfoLine label="Device" value={result.worker.device} />
          <InfoLine label="Compute" value={result.worker.compute_type} />
          <InfoLine label="Queue" value={result.worker.queue} />
          <InfoLine
            label="Jobs"
            value={
              result.worker.max_concurrent_jobs == null
                ? undefined
                : String(result.worker.max_concurrent_jobs)
            }
          />
        </div>
      )}
      {result.worker?.capabilities.length ? (
        <p className="mt-2 text-muted-foreground">
          Capabilities: {result.worker.capabilities.join(', ')}
        </p>
      ) : null}
    </div>
  );
}

function EndpointProbe({
  label,
  probe,
}: {
  label: string;
  probe: WorkerEndpointProbe;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className={probe.ok ? 'text-success' : 'text-destructive'}>
        {probe.ok ? '通过' : '失败'}
      </span>
      <span className="font-mono">{label}</span>
      {probe.status != null && <span>HTTP {probe.status}</span>}
      <span>{probe.latency_ms}ms</span>
      {probe.error && <span className="break-all text-destructive">{probe.error}</span>}
    </div>
  );
}

function InfoLine({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div className="min-w-0">
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-mono break-all">{value || '-'}</span>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-sm font-medium text-foreground mb-2">{label}</div>
      {children}
    </div>
  );
}

function dataDirSourceLabel(source: DataDirStatus['source']) {
  if (source === 'env') return '环境变量';
  if (source === 'config') return '本地配置';
  return '默认目录';
}
