// One object-detection server's settings, in its SQLite file (data/<name>.db, settings.ts of server-common),
// edited on its page (FIELDS): its name and source server, where it listens, the processing settings, the track
// cache, the registered clients with their tokens and options, access. Several servers with different databases run
// side by side, each its own filter chain for its own clients. A new database takes over an older config/<name>.json.
import { randomBytes } from "node:crypto";
import { defaultConfig, mergeConfig, type Config } from "@mrs6000/processing/config/config";
import { NotFoundError, ValueError } from "@mrs6000/server-common/errors";
import { loadSettings, SettingsDb } from "@mrs6000/server-common/settings";
import { CLASSES, type ClientOptions, type TrackClass } from "@mrs6000/wire/objects";
import type { SettingField } from "@mrs6000/wire/settings";

export interface ClientEntry { id: string; name: string; token: string; options: ClientOptions }

export interface ServerConfig {
  name: string;                              // what it says hello with at the source, and its folder in the cache
  source: { url: string; token: string };    // the source server, and this server's token there
  host: string; port: number;
  processing: unknown;                       // the pipeline settings (stages and their parameters), merged onto the defaults
  cache: string;                             // the track cache's folder, relative to the repository or absolute
  maxSessions: number;                       // replays (and background jobs) with their own processing at once
  clients: ClientEntry[];
  open: boolean;                             // unknown clients may connect
  adminToken: string;                        // when set, changes need "Authorization: Bearer <adminToken>"
  origins: string[];                         // other web pages allowed to make changes
}

export const defaults = (name: string): ServerConfig => ({
  name, source: { url: "http://127.0.0.1:8000", token: "" }, host: "127.0.0.1", port: 8020, processing: {},
  cache: "proc-servers/object-detection/cache", maxSessions: 2, clients: [], open: true, adminToken: "", origins: [],
});

/** what the page edits (GET/PUT /api/settings); the clients have their own routes */
export const FIELDS: SettingField[] = [
  { key: "source.url", label: "Source server", type: "url", group: "Source", help: "Where the sensors and recordings are. Changing it ends the replays." },
  { key: "source.token", label: "Token at the source", type: "secret", group: "Source", help: "Empty while the source lets unregistered servers connect." },
  { key: "name", label: "Name", type: "text", group: "Source", help: "How the source and the clients see this server; also its folder in the track cache." },
  { key: "host", label: "Address", type: "text", group: "Network", help: "127.0.0.1: this machine only. 0.0.0.0: every network (set an admin token first)." },
  { key: "port", label: "Port", type: "port", group: "Network", help: "Clients then need the new address; the page moves there." },
  { key: "maxSessions", label: "Replays with their own processing at once", type: "number", min: 1, max: 16, group: "Processing" },
  { key: "cache", label: "Track cache folder", type: "text", group: "Processing", help: "Relative to the repository, or absolute." },
  { key: "processing", label: "Processing settings", type: "json", group: "Processing", help: "Merged onto the defaults; the live processing and the replays follow at once." },
  { key: "open", label: "Unregistered clients may connect", type: "bool", group: "Access" },
  { key: "adminToken", label: "Admin token", type: "secret", group: "Access", help: "When set, every change needs it." },
  { key: "origins", label: "Other pages allowed to make changes", type: "lines", group: "Access", help: "One origin per line." },
];

export class Store {
  data: ServerConfig;
  private db: SettingsDb;

  /** `path` null: in memory only (tests); `name` for a new database; `legacy`: an older JSON file, taken over once */
  constructor(readonly path: string | null, name = "objects", legacy: string[] = []) {
    this.db = new SettingsDb(path);
    this.data = loadSettings(this.db, defaults(name), legacy);
    this.data.source = { ...defaults(name).source, ...this.data.source };
  }

  save(): void { this.db.save(this.data as unknown as Record<string, unknown>); }

  get processing(): Config { return mergeConfig(defaultConfig(), this.data.processing); }
  set processing(c: Config) { this.data.processing = c; this.save(); }

  addClient(c: unknown): ClientEntry {
    const b = (c ?? {}) as Partial<ClientEntry>;
    const e: ClientEntry = { id: randomBytes(6).toString("hex"), token: randomBytes(18).toString("base64url"), name: checkLabel(b.name),
                             options: checkOptions(b.options ?? {}) };
    this.data.clients.push(e);
    this.save();
    return e;
  }

  updateClient(id: string, u: unknown): ClientEntry {
    const c = this.client(id), b = (u ?? {}) as Partial<ClientEntry>;
    if (b.name !== undefined) c.name = checkLabel(b.name);
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

const checkLabel = (v: unknown): string => {
  if (typeof v !== "string" || !v.trim() || v.length > 80) throw new ValueError("name: 1 to 80 characters");
  return v.trim();
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
