import { useCallback, useEffect, useRef } from 'react';
import { loadSettings, saveSettings } from '../lib/settings';
import type { SourceType } from '../types';

function youTubeId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1) || null;
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/\/embed\/([\w-]{11})/);
    if (m) return m[1];
  } catch {
    // not a URL, fall through
  }
  return null;
}

function bilibiliBvid(input: string): string | null {
  const m = input.match(/BV[\w]+/);
  return m ? m[0] : null;
}

interface Props {
  materialId: number;
  sourceType: SourceType;
  sourceRef: string;
}

const PROGRESS_PREFIX = 'listen-panel:video-progress:';
const YOUTUBE_API_SRC = 'https://www.youtube.com/iframe_api';

interface YouTubePlayer {
  destroy(): void;
  getCurrentTime(): number;
  getDuration(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
}

interface YouTubePlayerEvent {
  target: YouTubePlayer;
  data: number;
}

interface YouTubeNamespace {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      width: string;
      height: string;
      playerVars: Record<string, string | number>;
      events: {
        onReady?: (event: { target: YouTubePlayer }) => void;
        onStateChange?: (event: YouTubePlayerEvent) => void;
      };
    },
  ) => YouTubePlayer;
  PlayerState: {
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
  };
}

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
    __listenPanelYouTubeReady?: Promise<void>;
  }
}

export default function VideoPlayer({ materialId, sourceType, sourceRef }: Props) {
  if (!sourceRef) {
    return (
      <Placeholder>未配置视频源</Placeholder>
    );
  }
  if (sourceType === 'local') {
    const looksRemote =
      /^https?:\/\//.test(sourceRef) ||
      sourceRef.startsWith('blob:') ||
      sourceRef.startsWith('/api/');
    const src = looksRemote
      ? sourceRef
      : `/api/media/${encodeURIComponent(sourceRef)}`;
    return (
      <LocalVideo
        src={src}
        progressKey={progressKey(materialId, sourceRef)}
      />
    );
  }
  if (sourceType === 'youtube') {
    const id = youTubeId(sourceRef);
    if (!id) return <Placeholder error>无法解析 YouTube 链接:{sourceRef}</Placeholder>;
    return (
      <YouTubeVideo
        videoId={id}
        progressKey={progressKey(materialId, `youtube:${id}`)}
      />
    );
  }
  if (sourceType === 'bilibili') {
    const bv = bilibiliBvid(sourceRef);
    if (!bv) return <Placeholder error>无法解析 Bilibili BV 号:{sourceRef}</Placeholder>;
    return (
      <BilibiliVideo
        bvid={bv}
        progressKey={progressKey(materialId, `bilibili:${bv}`)}
      />
    );
  }
  return null;
}

function LocalVideo({ src, progressKey }: { src: string; progressKey: string }) {
  const restoredRef = useRef(false);
  const lastSavedAtRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const setRef = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (!el) return;
    el.volume = loadSettings().default_volume;
  }, []);

  useEffect(() => {
    return () => {
      if (videoRef.current) saveVideoProgress(progressKey, videoRef.current);
    };
  }, [progressKey]);

  function onLoadedMetadata(e: React.SyntheticEvent<HTMLVideoElement>) {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const saved = loadVideoProgress(progressKey);
    if (saved == null) return;

    const video = e.currentTarget;
    if (Number.isFinite(video.duration) && video.duration > 0) {
      if (saved >= video.duration - 3) return;
      video.currentTime = Math.max(0, Math.min(saved, video.duration - 1));
    } else {
      video.currentTime = Math.max(0, saved);
    }
  }

  function onTimeUpdate(e: React.SyntheticEvent<HTMLVideoElement>) {
    const now = Date.now();
    if (now - lastSavedAtRef.current < 1500) return;
    lastSavedAtRef.current = now;
    saveVideoProgress(progressKey, e.currentTarget);
  }

  function onVolumeChange(e: React.SyntheticEvent<HTMLVideoElement>) {
    saveSettings({ default_volume: e.currentTarget.volume });
  }
  return (
    <video
      ref={setRef}
      src={src}
      controls
      onLoadedMetadata={onLoadedMetadata}
      onTimeUpdate={onTimeUpdate}
      onPause={(e) => saveVideoProgress(progressKey, e.currentTarget)}
      onEnded={() => clearVideoProgress(progressKey)}
      onVolumeChange={onVolumeChange}
      className="w-full h-full bg-black"
    />
  );
}

function YouTubeVideo({
  videoId,
  progressKey,
}: {
  videoId: string;
  progressKey: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const timerRef = useRef<number | null>(null);

  const stopSaving = useCallback(() => {
    if (timerRef.current == null) return;
    window.clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const saveCurrentProgress = useCallback(() => {
    if (playerRef.current) saveYouTubeProgress(progressKey, playerRef.current);
  }, [progressKey]);

  const startSaving = useCallback(() => {
    if (timerRef.current != null) return;
    timerRef.current = window.setInterval(saveCurrentProgress, 1500);
  }, [saveCurrentProgress]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    host.replaceChildren();
    playerRef.current = null;
    stopSaving();

    loadYouTubeApi()
      .then(() => {
        if (cancelled || !window.YT || !hostRef.current) return;
        playerRef.current = new window.YT.Player(hostRef.current, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            playsinline: 1,
            rel: 0,
            origin: window.location.origin,
          },
          events: {
            onReady: (event) => {
              restoreYouTubeProgress(progressKey, event.target);
            },
            onStateChange: (event) => {
              const state = window.YT?.PlayerState;
              if (!state) return;
              if (event.data === state.PLAYING) {
                startSaving();
              } else if (event.data === state.PAUSED) {
                stopSaving();
                saveYouTubeProgress(progressKey, event.target);
              } else if (event.data === state.ENDED) {
                stopSaving();
                clearVideoProgress(progressKey);
              }
            },
          },
        });
      })
      .catch(() => {
        // Keep the placeholder area stable; the embed can be retried on remount.
      });

    return () => {
      cancelled = true;
      stopSaving();
      if (playerRef.current) {
        saveYouTubeProgress(progressKey, playerRef.current);
        playerRef.current.destroy();
        playerRef.current = null;
      }
      host.replaceChildren();
    };
  }, [progressKey, startSaving, stopSaving, videoId]);

  useEffect(() => {
    const onBeforeUnload = () => saveCurrentProgress();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveCurrentProgress]);

  return <div ref={hostRef} className="w-full h-full bg-black" />;
}

function BilibiliVideo({
  bvid,
  progressKey,
}: {
  bvid: string;
  progressKey: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const currentSecondsRef = useRef(loadVideoProgress(progressKey) ?? 0);
  const playingRef = useRef(false);
  const playStartedAtRef = useRef<number | null>(null);

  const flushProgress = useCallback(() => {
    if (playingRef.current && playStartedAtRef.current != null) {
      const elapsed = (Date.now() - playStartedAtRef.current) / 1000;
      if (elapsed > 0) {
        currentSecondsRef.current += elapsed;
        playStartedAtRef.current = Date.now();
      }
    }
    saveProgressSeconds(progressKey, currentSecondsRef.current);
  }, [progressKey]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (!isBilibiliOrigin(e.origin)) return;

      const message = parseBilibiliMessage(e.data);
      if (!message) return;

      const explicitSeconds = extractSeconds(message);
      if (explicitSeconds != null) {
        currentSecondsRef.current = explicitSeconds;
        saveProgressSeconds(progressKey, explicitSeconds);
      }

      const type = typeof message.type === 'string' ? message.type : '';
      if (type === 'playing') {
        playingRef.current = true;
        playStartedAtRef.current = Date.now();
      } else if (type === 'paused') {
        flushProgress();
        playingRef.current = false;
        playStartedAtRef.current = null;
      } else if (type === 'ended') {
        playingRef.current = false;
        playStartedAtRef.current = null;
        clearVideoProgress(progressKey);
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [flushProgress, progressKey]);

  useEffect(() => {
    const onBeforeUnload = () => flushProgress();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushProgress();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      flushProgress();
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [flushProgress]);

  return (
    <iframe
      ref={iframeRef}
      src={bilibiliSrc(bvid, currentSecondsRef.current)}
      scrolling="no"
      allowFullScreen
      className="w-full h-full border-0 bg-black"
    />
  );
}

function progressKey(materialId: number, sourceRef: string): string {
  return `${PROGRESS_PREFIX}${materialId}:${sourceRef}`;
}

function loadVideoProgress(key: string): number | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as {
      time?: unknown;
    } | null;
    return typeof parsed?.time === 'number' && Number.isFinite(parsed.time)
      ? parsed.time
      : null;
  } catch {
    return null;
  }
}

function saveVideoProgress(key: string, video: HTMLVideoElement) {
  if (!Number.isFinite(video.currentTime) || video.currentTime <= 0) return;
  saveProgressSeconds(key, video.currentTime);
}

function saveProgressSeconds(key: string, seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  localStorage.setItem(
    key,
    JSON.stringify({ time: seconds, updated_at: Date.now() }),
  );
}

function clearVideoProgress(key: string) {
  localStorage.removeItem(key);
}

function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (window.__listenPanelYouTubeReady) return window.__listenPanelYouTubeReady;

  window.__listenPanelYouTubeReady = new Promise((resolve) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      resolve();
    };

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${YOUTUBE_API_SRC}"]`,
    );
    if (existing) return;

    const script = document.createElement('script');
    script.src = YOUTUBE_API_SRC;
    script.async = true;
    document.head.appendChild(script);
  });

  return window.__listenPanelYouTubeReady;
}

function restoreYouTubeProgress(key: string, player: YouTubePlayer) {
  const saved = loadVideoProgress(key);
  if (saved == null) return;

  const duration = safePlayerNumber(() => player.getDuration());
  if (duration != null && duration > 0) {
    if (saved >= duration - 3) {
      clearVideoProgress(key);
      return;
    }
    player.seekTo(Math.max(0, Math.min(saved, duration - 1)), true);
    return;
  }

  player.seekTo(Math.max(0, saved), true);
}

function saveYouTubeProgress(key: string, player: YouTubePlayer) {
  const current = safePlayerNumber(() => player.getCurrentTime());
  if (current == null || current <= 0) return;

  const duration = safePlayerNumber(() => player.getDuration());
  if (duration != null && duration > 0 && current >= duration - 3) {
    clearVideoProgress(key);
    return;
  }

  saveProgressSeconds(key, current);
}

function safePlayerNumber(read: () => number): number | null {
  try {
    const value = read();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function bilibiliSrc(bvid: string, savedSeconds: number): string {
  const params = new URLSearchParams({
    bvid,
    page: '1',
    autoplay: '0',
    high_quality: '1',
  });
  if (savedSeconds > 0) {
    params.set('t', String(Math.floor(savedSeconds)));
  }
  return `https://player.bilibili.com/player.html?${params.toString()}`;
}

function isBilibiliOrigin(origin: string): boolean {
  try {
    return new URL(origin).hostname.endsWith('bilibili.com');
  } catch {
    return false;
  }
}

function parseBilibiliMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data === 'string') {
    const raw = data.startsWith('playerOperation-')
      ? data.slice('playerOperation-'.length)
      : data;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(data) ? data : null;
}

function extractSeconds(value: unknown): number | null {
  if (!isRecord(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item === 'number' &&
      Number.isFinite(item) &&
      item >= 0 &&
      /^(currentTime|current_time|time|seconds|progress)$/i.test(key)
    ) {
      return item;
    }
    if (isRecord(item)) {
      const nested = extractSeconds(item);
      if (nested != null) return nested;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function Placeholder({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div
      className={`w-full h-full grid place-items-center text-sm px-6 text-center ${
        error ? 'text-rose-500 bg-rose-50/40' : 'text-stone-400 bg-stone-100'
      }`}
    >
      {children}
    </div>
  );
}
