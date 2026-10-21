// The server's registry, stored in one JSON file (server.json, editable by hand):
//
//   {"sensors":  [{"name": "a", "ip": "192.168.178.200", "mount": "auto", "pose": {...}, "calibrated": "...", ...}],
//    "clients":  [{"id": "k3f9…", "name": "lobby display", "token": "…", "profile": "objects", "options": {...}}],
//    "processing": {...},            the pipeline settings (stages and their parameters), merged onto the defaults
//    "open": true,                   unknown clients may connect (with the objects profile)
//    "adminToken": "",               when set, changes need "Authorization: Bearer <adminToken>"
//    "maxSessions": 2}               replay sessions with their own processing at once
//
// The sensors are the rig (rig.ts) plus their addresses; an old rig.json is taken over on the first start.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { defaultConfig, mergeConfig, type Config } from "@mrs6000/processing/config/config";
import type { TrackClass } from "@mrs6000/processing/objects/tracker";
import { NotFoundError, ValueError } from "./errors";
import { checkName, loadRig, saveJson, type Rig, type RigSensor } from "./rig";
import type { MountSetting } from "./sensor/core";

export type Profile = "objects" | "debug";
export const PROFILES: readonly Profile[] = ["objects", "debug"];

/** how a client wants its objects: at most `rate` messages per second, only some classes, only inside a region of
 *  the floor, in its own coordinates (origin and yaw of its frame in the world), with trails */
export interface ClientOptions {
  rate?: number;
  classes?: TrackClass[];
  region?: [number, number][];      // a polygon, world x, y (m)
  transform?: { x: number; y: number; yaw: number };
  trails?: boolean;
}

export interface ClientEntry { id: string; name: string; token: string; profile: Profile; options: ClientOptions }

export interface SensorEntry extends RigSensor { enabled?: boolean; mount?: MountSetting }

export interface ServerConfig {
  sensors: SensorEntry[]; clients: ClientEntry[]; processing: unknown; open: boolean; adminToken: string; maxSessions: number;
}

const CLASSES: readonly TrackClass[] = ["person", "moving object", "object", "static object"];
const MOUNTS: readonly MountSetting[] = ["auto", "upright", "upsidedown"];

export class Store {
  data: ServerConfig;

  /** `path` null: in memory only (tests) */
  constructor(readonly path: string | null, legacyRig: string | null = null) {
    const blank: ServerConfig = { sensors: [], clients: [], processing: {}, open: true, adminToken: "", maxSessions: 2 };
    if (path && existsSync(path)) {
      const d = JSON.parse(readFileSync(path, "utf8")) as Partial<ServerConfig>;
      this.data = { ...blank, ...d, sensors: d.sensors ?? [], clients: d.clients ?? [] };
      for (const s of this.data.sensors) checkName(s.name);
    } else {
      this.data = blank;
      if (legacyRig && existsSync(legacyRig)) { this.data.sensors = loadRig(legacyRig).sensors; this.save(); }
    }
  }

  save(): void { if (this.path) saveJson(this.path, this.data); }

  get rig(): Rig { return { sensors: this.data.sensors }; }
  set rig(r: Rig) { this.data.sensors = r.sensors; this.save(); }

  get processing(): Config { return mergeConfig(defaultConfig(), this.data.processing); }
  set processing(c: Config) { this.data.processing = c; this.save(); }

  // --- sensors ---
  addSensor(s: unknown): SensorEntry {
    const e = sensorEntry(s);
    if (this.data.sensors.some(x => x.name === e.name)) throw new ValueError(`sensor ${e.name} exists already`);
    this.data.sensors.push(e);
    this.save();
    return e;
  }

  updateSensor(name: string, u: unknown): SensorEntry {
    const s = this.data.sensors.find(x => x.name === name);
    if (!s) throw new NotFoundError(`sensor ${name}`);
    Object.assign(s, sensorEntry({ ...s, ...(u as object), name }));
    this.save();
    return s;
  }

  removeSensor(name: string): void {
    const n = this.data.sensors.length;
    this.data.sensors = this.data.sensors.filter(s => s.name !== name);
    if (this.data.sensors.length === n) throw new NotFoundError(`sensor ${name}`);
    this.save();
  }

  // --- clients ---
  addClient(c: unknown): ClientEntry {
    const b = (c ?? {}) as Partial<ClientEntry>;
    const e: ClientEntry = { id: randomBytes(6).toString("hex"), token: randomBytes(18).toString("base64url"), name: checkLabel(b.name),
                             profile: checkProfile(b.profile ?? "objects"), options: checkOptions(b.options ?? {}) };
    this.data.clients.push(e);
    this.save();
    return e;
  }

  updateClient(id: string, u: unknown): ClientEntry {
    const c = this.client(id), b = (u ?? {}) as Partial<ClientEntry>;
    if (b.name !== undefined) c.name = checkLabel(b.name);
    if (b.profile !== undefined) c.profile = checkProfile(b.profile);
    if (b.options !== undefined) c.options = checkOptions(b.options);
    this.save();
    return c;
  }

  removeClient(id: string): void { this.client(id); this.data.clients = this.data.clients.filter(c => c.id !== id); this.save(); }

  client(id: string): ClientEntry {
    const c = this.data.clients.find(x => x.id === id);
    if (!c) throw new NotFoundError(`client ${id}`);
    return c;
  }

  byToken(token: string): ClientEntry | null { return (token && this.data.clients.find(c => c.token === token)) || null; }
}

function sensorEntry(s: unknown): SensorEntry {
  const b = (s ?? {}) as SensorEntry;
  const e: SensorEntry = { ...b, name: checkName(b.name) };
  if (b.ip !== undefined && (typeof b.ip !== "string" || !b.ip)) throw new ValueError("ip: an address");
  if (b.mount !== undefined && !MOUNTS.includes(b.mount)) throw new ValueError(`mount: one of ${MOUNTS.join(", ")}`);
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw new ValueError("enabled: true or false");
  return e;
}

const checkLabel = (v: unknown): string => {
  if (typeof v !== "string" || !v.trim() || v.length > 80) throw new ValueError("name: 1 to 80 characters");
  return v.trim();
};

const checkProfile = (v: unknown): Profile => {
  if (!PROFILES.includes(v as Profile)) throw new ValueError(`profile: one of ${PROFILES.join(", ")}`);
  return v as Profile;
};

export function checkOptions(o: unknown): ClientOptions {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new ValueError("options: an object");
  const b = o as Record<string, unknown>, out: ClientOptions = {};
  const num = (v: unknown, what: string) => { if (typeof v !== "number" || !Number.isFinite(v)) throw new ValueError(`${what}: a number`); return v; };
  for (const k of Object.keys(b)) if (!["rate", "classes", "region", "transform", "trails"].includes(k)) throw new ValueError(`options: unknown ${k}`);
  if (b.rate !== undefined) { out.rate = num(b.rate, "rate"); if (out.rate <= 0 || out.rate > 30) throw new ValueError("rate: more than 0, at most 30 per second"); }
  if (b.classes !== undefined) {
    if (!Array.isArray(b.classes) || b.classes.some(c => !CLASSES.includes(c as TrackClass))) throw new ValueError(`classes: some of ${CLASSES.join(", ")}`);
    out.classes = b.classes as TrackClass[];
  }
  if (b.region !== undefined) {
    if (!Array.isArray(b.region) || b.region.length < 3 || b.region.some(p => !Array.isArray(p) || p.length !== 2)) throw new ValueError("region: at least 3 [x, y] points");
    out.region = (b.region as unknown[][]).map(p => [num(p[0], "region x"), num(p[1], "region y")]);
  }
  if (b.transform !== undefined) {
    const t = b.transform as Record<string, unknown>;
    if (!t || typeof t !== "object") throw new ValueError("transform: {x, y, yaw}");
    out.transform = { x: num(t.x ?? 0, "transform x"), y: num(t.y ?? 0, "transform y"), yaw: num(t.yaw ?? 0, "transform yaw") };
  }
  if (b.trails !== undefined) { if (typeof b.trails !== "boolean") throw new ValueError("trails: true or false"); out.trails = b.trails; }
  return out;
}
