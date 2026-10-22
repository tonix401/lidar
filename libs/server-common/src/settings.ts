// A server's settings in one SQLite file (bun:sqlite): one row per top-level key, its value as JSON. A server loads
// them once, edits them through its page (GET/PUT /api/settings, the fields it describes) and saves every change.
// A JSON file of an older version is taken over once, while the database is still empty.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SettingField, SettingsView } from "@mrs6000/wire/settings";
import { ValueError } from "./errors";
import { loadJson } from "./json";

const SCHEMA = 1;

export class SettingsDb {
  private db: Database;

  /** `path` null: in memory only (tests) */
  constructor(readonly path: string | null) {
    if (path) mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path ?? ":memory:", { create: true, strict: true });
    this.db.run("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.db.run(`PRAGMA user_version = ${SCHEMA}`);
  }

  get empty(): boolean { return !this.db.query("SELECT 1 FROM settings LIMIT 1").get(); }

  load(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all()) out[r.key] = JSON.parse(r.value);
    return out;
  }

  /** replace every row with `data`'s keys, in one transaction */
  save(data: Record<string, unknown>): void {
    const put = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.db.transaction(() => {
      this.db.run("DELETE FROM settings WHERE key NOT IN (SELECT value FROM json_each(?))", [JSON.stringify(Object.keys(data))]);
      for (const [k, v] of Object.entries(data)) if (v !== undefined) put.run(k, JSON.stringify(v));
    })();
  }

  close(): void { this.db.close(); }
}

/** a server's settings: its defaults, then the database's rows (or, for a new database, the first older JSON file
 *  that exists, which is then saved); keys the defaults do not have are dropped */
export function loadSettings<T extends object>(db: SettingsDb, defaults: T, legacy: string[] = []): T {
  const known = (d: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, d[k] ?? structuredClone(v)])) as T;
  if (!db.empty) return known(db.load());
  const old = legacy.map(p => loadJson(p)).find(Boolean) ?? {};
  const d = known(old);
  db.save(d as Record<string, unknown>);
  return d;
}

/** for tests and tools: a database with these settings, before its server starts */
export function seedSettings(path: string, values: Record<string, unknown>): void {
  const db = new SettingsDb(path);
  db.save({ ...db.load(), ...values });
  db.close();
}

// ---------- the fields a page edits ----------
export function getPath(obj: object, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function setPath(obj: object, path: string, v: unknown): void {
  const keys = path.split("."), last = keys.pop()!;
  let o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (!o[k] || typeof o[k] !== "object") o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[last] = v;
}

export function settingsView(fields: SettingField[], data: object): SettingsView {
  return { fields, values: Object.fromEntries(fields.map(f => [f.key, getPath(data, f.key)])) };
}

/** a PUT's body checked against the fields: only known keys, each of its type (an unknown key is refused) */
export function checkPatch(fields: SettingField[], body: Record<string, unknown>): Record<string, unknown> {
  const byKey = new Map(fields.map(f => [f.key, f])), out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    const f = byKey.get(k);
    if (!f) throw new ValueError(`unknown setting ${k}`);
    out[k] = checkValue(f, v);
  }
  return out;
}

function checkValue(f: SettingField, v: unknown): unknown {
  const bad = (what: string) => new ValueError(`${f.label}: ${what}`);
  switch (f.type) {
    case "text": case "secret":
      if (typeof v !== "string" || v.length > 500) throw bad("text, at most 500 characters");
      return v.trim();
    case "url": {
      if (typeof v !== "string") throw bad("a URL");
      let u: URL;
      try { u = new URL(v.trim()); } catch { throw bad(`not a URL: ${v}`); }
      if (u.protocol !== "http:" && u.protocol !== "https:") throw bad("an http:// or https:// URL");
      return v.trim().replace(/\/+$/, "");
    }
    case "number": case "port": {
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) throw bad("a number");
      const [min, max] = f.type === "port" ? [0, 65535] : [f.min ?? -Infinity, f.max ?? Infinity];
      if (f.type === "port" && !Number.isInteger(n)) throw bad("a whole number");
      if (n < min || n > max) throw bad(`from ${min} to ${max}`);
      return n;
    }
    case "bool":
      if (typeof v !== "boolean") throw bad("true or false");
      return v;
    case "lines": {
      const list = typeof v === "string" ? v.split("\n") : v;
      if (!Array.isArray(list) || list.some(s => typeof s !== "string")) throw bad("a list of lines");
      return (list as string[]).map(s => s.trim()).filter(Boolean);
    }
    case "select":
      if (typeof v !== "string" || !(f.options ?? []).includes(v)) throw bad(`one of ${(f.options ?? []).map(o => o || "(none)").join(", ")}`);
      return v;
    case "json":
      if (!v || typeof v !== "object" || Array.isArray(v)) throw bad("a JSON object");
      return v;
  }
}

/** the keys of a checked patch whose values differ from the current settings */
export function changedKeys(patch: Record<string, unknown>, data: object): string[] {
  return Object.keys(patch).filter(k => JSON.stringify(patch[k]) !== JSON.stringify(getPath(data, k)));
}
