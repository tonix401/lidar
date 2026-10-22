// The debug server's settings, in its SQLite file (data/debug.db, settings.ts of server-common), edited in the
// viewer's Server section (FIELDS): its name and source server, where it listens, its own fused objects and their
// processing, a replay every page opens first, access. A new database takes over an older config/debug.json.
import { defaultConfig, mergeConfig, type Config } from "@mrs6000/processing/config/config";
import { loadSettings, SettingsDb } from "@mrs6000/server-common/settings";
import type { SettingField } from "@mrs6000/wire/settings";

export interface DebugConfig {
  name: string;                              // what it says hello with at the source
  source: { url: string; token: string };    // the source server, and this server's token there
  host: string; port: number;
  objects: boolean;                          // the server's own fused objects (GET /api/objects), next to the page's
  processing: unknown;                       // their pipeline settings, merged onto the defaults
  replay: string;                            // a recording every page opens first ("" for the live sensors)
  adminToken: string;                        // when set, changes need "Authorization: Bearer <adminToken>"
  origins: string[];                         // other web pages allowed to make changes
}

export const DEFAULTS: DebugConfig = { name: "debug", source: { url: "http://127.0.0.1:8000", token: "" }, host: "127.0.0.1", port: 8010,
                                       objects: true, processing: {}, replay: "", adminToken: "", origins: [] };

export const FIELDS: SettingField[] = [
  { key: "source.url", label: "Source server", type: "url", group: "Source", help: "Where the sensors and recordings are. Changing it starts every view afresh." },
  { key: "source.token", label: "Token at the source", type: "secret", group: "Source", help: "Empty while the source lets unregistered servers connect." },
  { key: "name", label: "Name", type: "text", group: "Source", help: "How the source server lists this server." },
  { key: "replay", label: "Replay every page opens first", type: "text", group: "Source", help: "A recording's name; empty: the live sensors." },
  { key: "host", label: "Address", type: "text", group: "Network", help: "127.0.0.1: this machine only. 0.0.0.0: every network (set an admin token first)." },
  { key: "port", label: "Port", type: "port", group: "Network", help: "The page moves to the new address." },
  { key: "objects", label: "The server's own fused objects", type: "bool", group: "Processing", help: "Next to the page's own, for comparison (GET /api/objects)." },
  { key: "processing", label: "Their processing settings", type: "json", group: "Processing", help: "Merged onto the defaults." },
  { key: "adminToken", label: "Admin token", type: "secret", group: "Access", help: "When set, changing these settings needs it." },
  { key: "origins", label: "Other pages allowed to make changes", type: "lines", group: "Access", help: "One origin per line." },
];

export class Store {
  data: DebugConfig;
  private db: SettingsDb;

  /** `path` null: in memory only (tests); `legacy`: an older JSON file, taken over once */
  constructor(readonly path: string | null, legacy: string[] = []) {
    this.db = new SettingsDb(path);
    this.data = loadSettings(this.db, DEFAULTS, legacy);
    this.data.source = { ...DEFAULTS.source, ...this.data.source };
  }

  save(): void { this.db.save(this.data as unknown as Record<string, unknown>); }

  get processing(): Config { return mergeConfig(defaultConfig(), this.data.processing); }
  set processing(c: Config) { this.data.processing = c; this.save(); }
}
