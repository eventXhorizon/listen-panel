const STORAGE_KEY = 'listen-panel.lastOpened';

type Store = Record<string, number>;

function read(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* quota / private mode — silently ignore */
  }
}

export function markOpened(materialId: number): void {
  const store = read();
  store[String(materialId)] = Date.now();
  write(store);
}

export function getLastOpenedMap(): Record<number, number> {
  const store = read();
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(store)) {
    const id = Number(k);
    if (Number.isFinite(id) && typeof v === 'number') out[id] = v;
  }
  return out;
}
