import type { AppSettings } from '../types';

const KEY = 'listen-panel:settings';

const DEFAULTS: AppSettings = {
  default_volume: 0.3,
};

export function loadSettings(): AppSettings {
  const raw = localStorage.getItem(KEY);
  if (!raw) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch: Partial<AppSettings>) {
  const next = { ...loadSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
}
