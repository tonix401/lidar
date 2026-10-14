// Per-browser settings. Every access is guarded: private windows / blocked storage just mean defaults.

export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

const memory = new Map<string, string>();
const fallback: KV = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v), removeItem: k => void memory.delete(k) };

export class Store {
  constructor(private kv: KV = (typeof localStorage !== "undefined" ? localStorage : fallback)) {}

  get(key: string): string | null {
    try { return this.kv.getItem(key); } catch { return null; }
  }
  set(key: string, value: string): void {
    try { this.kv.setItem(key, value); } catch { /* storage full or blocked */ }
  }
  remove(key: string): void {
    try { this.kv.removeItem(key); } catch { /* ignore */ }
  }
  json<T>(key: string): T | null {
    const v = this.get(key);
    if (v === null) return null;
    try { return JSON.parse(v) as T; } catch { return null; }
  }
  setJson(key: string, value: unknown): void { this.set(key, JSON.stringify(value)); }
}

export const KEYS = {
  smoothing: "mrs6000.smoothing.v3",       // { mode, manual }
  layerBias: "mrs6000.layerbias.v2",
  mount: "mrs6000.mount.v2",
  view: "mrs6000.view",
  fillWalls: "mrs6000.fillWalls",
  objectToggle: (k: string) => "mrs6000.obj." + k,
} as const;
