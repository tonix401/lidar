// The source server's settings, in its SQLite file (data/source.db, settings.ts of server-common), edited on its
// page: the sensors (registry: name, address, enabled, mount, which one is the main one, and the live rig's poses), the processing servers that
// may connect with their tokens, and the server's own settings (FIELDS: where it listens, the recordings folder,
// access). A new database starts as a copy of the committed empty one (empty.db, written from DEFAULTS by
// scripts/empty-db.ts).
import { randomBytes } from "node:crypto";
import { NotFoundError, ValueError } from "@mrs6000/server-common/errors";
import { checkName } from "@mrs6000/server-common/names";
import type { MountSetting } from "@mrs6000/server-common/sensor/core";
import { loadSettings, SettingsDb } from "@mrs6000/server-common/settings";
import type { Rig, RigSensor } from "@mrs6000/wire/rig";
import { levelEntry } from "./rig";
import type { SettingField } from "@mrs6000/wire/settings";

export interface SensorEntry extends RigSensor { ip?: string; enabled?: boolean; mount?: MountSetting }
export interface ConsumerEntry { name: string; token: string }
export interface SourceConfig {
  host: string; port: number; recordings: string;       // recordings: a folder, relative to the repository or absolute
  sensors: SensorEntry[]; consumers: ConsumerEntry[];
  open: boolean;                                         // processing servers without a token may connect
  adminToken: string;                                    // when set, changes need "Authorization: Bearer <adminToken>"
  origins: string[];                                     // other web pages allowed to make changes
}

export const DEFAULTS: SourceConfig = { host: "127.0.0.1", port: 8000, recordings: "recordings", sensors: [], consumers: [], open: true,
                                        adminToken: "", origins: [] };

/** what the page edits (GET/PUT /api/settings); the sensors and consumers have their own routes */
export const FIELDS: SettingField[] = [
  { key: "host", label: "Address", type: "text", group: "Network",
    help: "127.0.0.1: this machine only. 0.0.0.0: every network (set an admin token first)." },
  { key: "port", label: "Port", type: "port", group: "Network", help: "The processing servers then need the new address as their source." },
  { key: "recordings", label: "Recordings folder", type: "text", group: "Recordings", help: "Relative to the repository, or absolute. Not while recording." },
  { key: "open", label: "Unregistered processing servers may connect", type: "bool", group: "Access" },
  { key: "adminToken", label: "Admin token", type: "secret", group: "Access", help: "When set, every change needs it (the field at the top of the page)." },
  { key: "origins", label: "Other pages allowed to make changes", type: "lines", group: "Access", help: "One origin per line, e.g. http://localhost:5174. Their host names also count as names of this server: add e.g. http://box.lan:8000 when it is reached by a DNS name." },
];

const MOUNTS: readonly MountSetting[] = ["auto", "upright", "upsidedown"];

export class Store {
  data: SourceConfig;
  private db: SettingsDb;

  /** `path` null: in memory only (tests); `template`: the empty database a new one starts from */
  constructor(readonly path: string | null, template?: string) {
    this.db = new SettingsDb(path, template);
    this.data = loadSettings(this.db, DEFAULTS);
    const tilted: string[] = [];
    this.data.sensors = this.data.sensors.map(s => levelEntry(sensorEntry(s), tilted));
    if (tilted.length) console.warn(`stored poses of ${tilted.join(", ")} were tilted: sensors are level now, so their pitch and roll were dropped; calibrate again`);
    this.normalizeMain();
    if (path) this.save();                   // keys added since the database was made get stored too
  }

  save(): void { this.db.save(this.data as unknown as Record<string, unknown>); }

  /** the live rig: the sensors' names and poses */
  get rig(): Rig { return { sensors: this.data.sensors }; }
  set rig(r: Rig) {
    const byName = new Map(r.sensors.map(s => [s.name, s]));
    this.data.sensors = this.data.sensors.map(s => {
      const e = byName.get(s.name), out: SensorEntry = { ...s, ...(e ?? {}) };
      if (e && !e.main) delete out.main;
      return out;
    });
    for (const s of r.sensors) if (!this.data.sensors.some(x => x.name === s.name)) this.data.sensors.push({ ...s });
    this.normalizeMain();
    this.save();
  }

  /** exactly one main sensor: the first, unless one is marked */
  private normalizeMain(): void {
    const k = Math.max(0, this.data.sensors.findIndex(s => s.main));
    this.data.sensors.forEach((s, i) => { if (i === k) s.main = true; else delete s.main; });
  }

  addSensor(s: unknown): SensorEntry {
    const e = sensorEntry(s);
    if (this.data.sensors.some(x => x.name === e.name)) throw new ValueError(`sensor ${e.name} exists already`);
    delete e.main;
    this.data.sensors.push(e);
    this.normalizeMain();
    this.save();
    return e;
  }

  /** change a sensor's connection settings (ip, enabled, mount), or its name with `rename` (it keeps its pose). Which
   *  sensor is the main one is changed with hub.ts setOrigin, which moves the poses with it. */
  updateSensor(name: string, u: unknown): SensorEntry {
    const s = this.data.sensors.find(x => x.name === name);
    if (!s) throw new NotFoundError(`sensor ${name}`);
    const { rename, main: _, ...rest } = (u ?? {}) as { rename?: unknown; main?: unknown };
    let to = name;
    if (rename !== undefined && rename !== name) {
      to = checkName(rename);
      if (this.data.sensors.some(x => x.name === to)) throw new ValueError(`sensor ${to} exists already`);
    }
    Object.assign(s, sensorEntry({ ...s, ...rest, name: to }));
    this.save();
    return s;
  }

  removeSensor(name: string): void {
    const n = this.data.sensors.length;
    this.data.sensors = this.data.sensors.filter(s => s.name !== name);
    if (this.data.sensors.length === n) throw new NotFoundError(`sensor ${name}`);
    this.normalizeMain();
    this.save();
  }

  addConsumer(c: unknown): ConsumerEntry {
    const name = (c as { name?: unknown })?.name;
    if (typeof name !== "string" || !name.trim() || name.length > 80) throw new ValueError("name: 1 to 80 characters");
    const e = { name: name.trim(), token: randomBytes(18).toString("base64url") };
    this.data.consumers.push(e);
    this.save();
    return e;
  }

  removeConsumer(name: string): void {
    const n = this.data.consumers.length;
    this.data.consumers = this.data.consumers.filter(c => c.name !== name);
    if (this.data.consumers.length === n) throw new NotFoundError(`consumer ${name}`);
    this.save();
  }

  consumerByToken(token: string | undefined): ConsumerEntry | null { return (token && this.data.consumers.find(c => c.token === token)) || null; }
}

function sensorEntry(s: unknown): SensorEntry {
  const b = (s ?? {}) as SensorEntry;
  const e: SensorEntry = { ...b, name: checkName(b.name) };
  if (b.ip !== undefined && (typeof b.ip !== "string" || !b.ip)) throw new ValueError("ip: an address");
  if (b.mount !== undefined && !MOUNTS.includes(b.mount)) throw new ValueError(`mount: one of ${MOUNTS.join(", ")}`);
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw new ValueError("enabled: true or false");
  if (b.main !== undefined && typeof b.main !== "boolean") throw new ValueError("main: true or false");
  return e;
}
