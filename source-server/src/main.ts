// The source server: the sensors, their recordings, and the raw streams every processing server works from.
//
//   bun source-server/src/main.ts                       the settings in data/source.db → http://localhost:8000 at first
//   bun source-server/src/main.ts --offline             no sensor connection at all (replays only: tests, demos)
//   bun source-server/src/main.ts --db other.db         another settings database
//
// Everything else is a setting, in the database and on the server's page (store.ts, settings.ts): the sensors, where
// it listens, the recordings folder, access. A new database starts as a copy of empty.db.
// The sensors are the registry's (with an address, not disabled), else one sensor "sensor" at the default address.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { describeError } from "@mrs6000/server-common/errors";
import { Stop, supervised } from "@mrs6000/server-common/health";
import { Listener } from "@mrs6000/server-common/listener";
import { log } from "@mrs6000/server-common/log";
import { Hub } from "./hub";
import { createApp } from "./http";
import { LiveSensor } from "./live";
import { RestClient } from "./rest";
import type { SensorSpec } from "./rig";
import { applySettings, recordingsDir } from "./settings";
import { statusLoop } from "./status";
import { Store, type SensorEntry } from "./store";
import { DEFAULT_IP } from "./variables";
import { Consumers, type Conn } from "./ws";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), ".."), REPO = resolve(HERE, "..");
const WEB = resolve(HERE, "web/dist");

export interface Args { db: string; offline: boolean }

export function parse(argv: string[]): Args {
  const { values: v } = parseArgs({
    args: argv, strict: true, allowPositionals: false,
    options: { db: { type: "string", default: resolve(HERE, "data/source.db") }, offline: { type: "boolean", default: false },
               help: { type: "boolean", default: false } },
  });
  if (v.help) {
    console.log("usage: source-server [--db data/source.db] [--offline]\n  every other setting is in the database, edited on the server's page");
    process.exit(0);
  }
  return { db: resolve(v.db!), offline: !!v.offline };
}

/** the live sensors: the registry's (with an address, not disabled), else one at the default address */
export function sensorSpecs(registry: SensorEntry[]): SensorSpec[] {
  const inRegistry = registry.filter(s => s.ip && s.enabled !== false).map(s => ({ name: s.name, ip: s.ip! }));
  return inRegistry.length ? inRegistry : [{ name: "sensor", ip: DEFAULT_IP }];
}

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  let args: Args, store: Store;
  try {
    args = parse(argv);
    store = new Store(args.db, resolve(HERE, "empty.db"));
  } catch (e) {
    console.error(`error: ${describeError(e)}`);
    process.exit(2);
  }
  const liveSensors = () => (args.offline ? [] : sensorSpecs(store.data.sensors)).map(s => new LiveSensor(s.name, { kind: "cola", ip: s.ip }, s.ip));
  const hub = new Hub(recordingsDir(REPO, store.data.recordings), store);
  const consumers = new Consumers(hub, store);
  let polls = new Stop();
  const poll = () => {                                     // each live sensor's REST status
    polls.set(); polls = new Stop();
    for (const s of hub.live) void supervised(`${s.label} status poll`, () => statusLoop(new RestClient(s.ip, 3), s, polls), polls);
  };
  let listener: Listener<Conn>;
  const app = createApp(hub, store, {
    webDir: WEB, consumers, onRegistry: () => { hub.setLive(liveSensors()); poll(); },
    onSettings: b => {
      const out = applySettings(hub, store, listener, REPO, b);
      if (out.moved) log(`source server moved to ${listener.url}`);
      return out;
    },
  });
  try {                                                    // bind first: a busy port is reported in one line, nothing started
    listener = new Listener<Conn>(at => Bun.serve<Conn>({
      hostname: at.host, port: at.port, idleTimeout: 30, websocket: consumers.websocket,
      fetch: (req, srv) => {
        if (new URL(req.url).pathname !== "/ws") return app(req);
        const up = consumers.upgrade(req, srv);
        return up === true ? undefined : up === false ? new Response("expected a WebSocket", { status: 400 }) : up;
      },
    }), { host: store.data.host, port: store.data.port });
  } catch (e) {
    console.error(`error: cannot listen on ${store.data.host}:${store.data.port} (settings in ${args.db}): ${describeError(e)}`);
    process.exit(1);
  }
  hub.setLive(liveSensors());
  poll();
  const specs = hub.live.map(s => `${s.name} ${s.ip}`);
  const src = args.offline ? "offline" : specs.length > 1 ? specs.join(", ") : specs.length ? `sensor ${hub.live[0].ip}` : "no sensors";
  log(`source server on ${listener.url}  (${src}; recordings in ${hub.recDir}; consumers on /ws; settings in ${args.db})`);
  const quit = async () => { polls.set(); consumers.close(); await hub.shutdown(); listener.stop(); process.exit(0); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

if (import.meta.main) void main();
