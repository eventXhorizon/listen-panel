import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth-context';
import { loadSettings, saveSettings } from '../lib/settings';
import type { LlmStatus, TtsStatus } from '../types';

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
  const [ttsBaseUrl, setTtsBaseUrl] = useState('');
  const [ttsVoiceId, setTtsVoiceId] = useState('');
  const [ttsModel, setTtsModel] = useState('');
  const [ttsOutputFormat, setTtsOutputFormat] = useState('');
  const [showTtsKey, setShowTtsKey] = useState(false);

  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [ttsLoadErr, setTtsLoadErr] = useState<string | null>(null);

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
        const res = await fetch('/api/settings/tts', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const s = (await res.json()) as TtsStatus;
        setTtsStatus(s);
        setTtsBaseUrl(s.base_url);
        setTtsVoiceId(s.voice_id);
        setTtsModel(s.model);
        setTtsOutputFormat(s.output_format);
      } catch (e) {
        setTtsLoadErr((e as Error).message);
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
        ttsBaseUrl.trim() &&
        ttsBaseUrl.trim() !== ttsStatus.base_url
      ) {
        ttsPatch.base_url = ttsBaseUrl.trim();
      }
      if (
        ttsStatus &&
        ttsVoiceId.trim() &&
        ttsVoiceId.trim() !== ttsStatus.voice_id
      ) {
        ttsPatch.voice_id = ttsVoiceId.trim();
      }
      if (ttsStatus && ttsModel.trim() && ttsModel.trim() !== ttsStatus.model) {
        ttsPatch.model = ttsModel.trim();
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

      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      alert(`保存失败:${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  const keyPlaceholder = status?.configured
    ? '已配置 ●●●●●● (留空保留现有 key)'
    : 'sk-...';
  const ttsKeyPlaceholder = ttsStatus?.configured
    ? '已配置 ●●●●●● (留空保留现有 key)'
    : 'sk_...';

  if (!auth.user?.is_admin) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-10 w-full">
          <h1 className="text-2xl font-medium text-stone-900 tracking-tight mb-2">
            设置
          </h1>
          <p className="text-sm text-stone-500">
            只有管理员可以查看和修改 DeepSeek / ElevenLabs 凭据。
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-10 w-full">
        <h1 className="text-2xl font-medium text-stone-900 tracking-tight mb-2">
          设置
        </h1>
        <p className="text-sm text-stone-500 mb-8">
          DeepSeek 与 TTS 凭据保存在 <code className="text-xs bg-stone-100 px-1 py-0.5 rounded">backend/data/</code>
          (已 gitignore),不会进数据库,API key 也不会回传到前端。本地音量存浏览器 localStorage。
        </p>

        <div className="space-y-7">
          <section className="bg-white border border-stone-200 rounded-lg p-5">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="text-sm font-medium text-stone-800">DeepSeek</h2>
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
                    className="flex-1 bg-white border border-stone-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-stone-400"
                  />
                  <button
                    type="button"
                    onClick={() => setShow((s) => !s)}
                    className="px-3 py-2 rounded-md border border-stone-200 text-xs hover:bg-stone-50"
                  >
                    {show ? '隐藏' : '显示'}
                  </button>
                </div>
                <p className="mt-2 text-xs text-stone-500">
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
                  className="w-full bg-white border border-stone-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-stone-400"
                />
                <p className="mt-2 text-xs text-stone-500">
                  兼容 OpenAI 协议的代理(SiliconFlow / DashScope 等)在这里改。
                </p>
              </Field>

              <Field label="模型">
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="deepseek-chat"
                  className="w-full bg-white border border-stone-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-stone-400"
                />
              </Field>
            </div>
          </section>

          <section className="bg-white border border-stone-200 rounded-lg p-5">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="text-sm font-medium text-stone-800">ElevenLabs TTS</h2>
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
                    className="flex-1 bg-white border border-stone-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-stone-400"
                  />
                  <button
                    type="button"
                    onClick={() => setShowTtsKey((s) => !s)}
                    className="px-3 py-2 rounded-md border border-stone-200 text-xs hover:bg-stone-50"
                  >
                    {showTtsKey ? '隐藏' : '显示'}
                  </button>
                </div>
                <p className="mt-2 text-xs text-stone-500">
                  申请地址:
                  <a
                    href="https://elevenlabs.io/app/settings/api-keys"
                    target="_blank"
                    rel="noreferrer"
                    className="underline ml-1"
                  >
                    elevenlabs.io/app/settings/api-keys
                  </a>
                </p>
              </Field>

              <Field label="Base URL">
                <input
                  value={ttsBaseUrl}
                  onChange={(e) => setTtsBaseUrl(e.target.value)}
                  placeholder="https://api.elevenlabs.io"
                  className="w-full bg-white border border-stone-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-stone-400"
                />
              </Field>

              <Field label="Voice ID">
                <input
                  value={ttsVoiceId}
                  onChange={(e) => setTtsVoiceId(e.target.value)}
                  placeholder="JBFqnCBsd6RMkjVDRZzb"
                  className="w-full bg-white border border-stone-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-stone-400"
                />
              </Field>

              <Field label="模型">
                <input
                  value={ttsModel}
                  onChange={(e) => setTtsModel(e.target.value)}
                  placeholder="eleven_multilingual_v2"
                  className="w-full bg-white border border-stone-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-stone-400"
                />
              </Field>

              <Field label="输出格式">
                <input
                  value={ttsOutputFormat}
                  onChange={(e) => setTtsOutputFormat(e.target.value)}
                  placeholder="mp3_44100_128"
                  className="w-full bg-white border border-stone-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-stone-400"
                />
              </Field>
            </div>
          </section>

          <section className="bg-white border border-stone-200 rounded-lg p-5">
            <h2 className="text-sm font-medium text-stone-800 mb-4">播放</h2>
            <Field label="本地视频默认音量">
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                  className="flex-1 accent-stone-700"
                />
                <span className="text-sm text-stone-700 font-mono w-12 text-right tabular-nums">
                  {Math.round(volume * 100)}%
                </span>
              </div>
              <p className="mt-2 text-xs text-stone-500">
                Reader 起播时本地视频用这个值,播放过程中调整也会写回。YouTube/Bilibili 走自己的播放器。
              </p>
            </Field>
          </section>

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={onSave}
              disabled={saving}
              className="px-4 py-2 rounded-md bg-stone-900 text-white text-sm hover:bg-stone-700 disabled:opacity-50"
            >
              {saving ? '保存中...' : '保存'}
            </button>
            {savedAt && (
              <span className="text-xs text-stone-500">已保存 · {savedAt}</span>
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
      <span className="text-xs px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200">
        后端不可达 · {loadErr}
      </span>
    );
  }
  if (!status) {
    return <span className="text-xs text-stone-400">读取中...</span>;
  }
  if (status.configured) {
    return (
      <span className="text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
        ● 已配置
      </span>
    );
  }
  return (
    <span className="text-xs px-2 py-0.5 rounded bg-stone-100 text-stone-600 border border-stone-200">
      ○ 未配置
    </span>
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
      <div className="text-sm font-medium text-stone-800 mb-2">{label}</div>
      {children}
    </div>
  );
}
