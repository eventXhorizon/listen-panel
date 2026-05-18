import type { Material } from '../types';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

export function extractYouTubeId(sourceRef: string): string | null {
  const ref = sourceRef.trim();
  if (!ref) return null;

  try {
    const url = new URL(ref);
    if (!YOUTUBE_HOSTS.has(url.hostname)) return null;

    if (url.hostname === 'youtu.be') {
      const id = url.pathname.replace(/^\//, '').split('/')[0];
      return id || null;
    }

    if (url.pathname === '/watch') {
      return url.searchParams.get('v');
    }

    const shortsMatch = url.pathname.match(/^\/shorts\/([^/]+)/);
    if (shortsMatch) return shortsMatch[1];

    const embedMatch = url.pathname.match(/^\/embed\/([^/]+)/);
    if (embedMatch) return embedMatch[1];

    return null;
  } catch {
    // not a URL — try a raw 11-char id
    if (/^[A-Za-z0-9_-]{11}$/.test(ref)) return ref;
    return null;
  }
}

export function materialCoverUrl(m: Material): string | null {
  if (m.source_type === 'youtube') {
    const id = extractYouTubeId(m.source_ref);
    return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
  }
  return null;
}
