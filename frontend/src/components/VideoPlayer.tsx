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
      <iframe
        src={`https://www.youtube.com/embed/${id}`}
        title="YouTube"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className="w-full h-full border-0 bg-black"
      />
    );
  }
  if (sourceType === 'bilibili') {
    const bv = bilibiliBvid(sourceRef);
    if (!bv) return <Placeholder error>无法解析 Bilibili BV 号:{sourceRef}</Placeholder>;
    return (
      <iframe
        src={`https://player.bilibili.com/player.html?bvid=${bv}&page=1&autoplay=0&high_quality=1`}
        scrolling="no"
        allowFullScreen
        className="w-full h-full border-0 bg-black"
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
  localStorage.setItem(
    key,
    JSON.stringify({ time: video.currentTime, updated_at: Date.now() }),
  );
}

function clearVideoProgress(key: string) {
  localStorage.removeItem(key);
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
