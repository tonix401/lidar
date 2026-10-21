// Server entry point.
//
//   bun server/src/main.ts                                      # live sensor(s) → http://localhost:8000
//   bun server/src/main.ts --sensor a=192.168.178.200 --sensor b=192.168.178.201      # several sensors
//   bun server/src/main.ts --replay recordings/walk.tpc         # also a replay session, which pages open
//   bun server/src/main.ts --offline --replay x.tpc             # no sensor connection at all (tests, demos)
//
// The sensors are --sensor NAME=IP, else the registry's (server.json, store.ts; an old rig.json is taken over on the
// first start), else one sensor "sensor" at --ip.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { describeError, ValueError } from "./errors";
import { Hub, LiveSensor } from "./hub";
import { Stop, supervised } from "./health";
import { createApp } from "./http";
import { log } from "./log";
import { RestClient } from "./rest";
import { parseSensorArg, type Rig, type SensorSpec } from "./rig";
import { Store } from "./store";
import { Clients, type Conn } from "./ws";
import { statusLoop } from "./status";
import { DEFAULT_IP } from "./variables";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface Args {
  ip?: string; sensor: string[]; rig: string; store: string; host: string; port: number; recordings: string; frontend: string;
  record?: string; replay?: string; offline: boolean;
}

export function parse(argv: string[]): Args {
  const { values: v } = parseArgs({
    args: argv, strict: true, allowPositionals: false,
    options: {
      ip: { type: "string" }, sensor: { type: "string", multiple: true, default: [] }, rig: { type: "string", default: resolve(REPO, "rig.json") },
      store: { type: "string", default: resolve(REPO, "server.json") },
      host: { type: "string", default: "127.0.0.1" }, port: { type: "string", default: "8000" },
      recordings: { type: "string", default: resolve(REPO, "recordings") }, frontend: { type: "string", default: resolve(REPO, "frontend/dist") },
      record: { type: "string" }, replay: { type: "string" }, offline: { type: "boolean", default: false }, help: { type: "boolean", default: false },
    },
  });
  if (v.help) {
    console.log("usage: server [--ip IP | --sensor NAME=IP ...] [--store server.json] [--rig rig.json (taken over once)] [--host 127.0.0.1] [--port 8000] [--recordings DIR] " +
                "[--frontend DIR] [--record FILE] [--replay FILE] [--offline]");
    process.exit(0);
  }
  const port = Number(v.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ValueError(`--port ${v.port}: expected a port number`);
  return { ip: v.ip, sensor: v.sensor ?? [], rig: v.rig!, store: v.store!, host: v.host!, port, recordings: v.recordings!, frontend: v.frontend!,
           record: v.record, replay: v.replay, offline: !!v.offline };
}

export function sensorSpecs(args: Pick<Args, "ip" | "sensor">, rig: Rig): SensorSpec[] {
  if (args.sensor.length) {
    if (args.ip) throw new ValueError("use either --ip or --sensor");
    const specs = args.sensor.map(parseSensorArg);
    if (new Set(specs.map(s => s.name)).size !== specs.length) throw new ValueError("--sensor: names must differ");
    return specs;
  }
  const inRig = rig.sensors.filter(s => s.ip).map(s => ({ name: s.name, ip: s.ip! }));
  if (inRig.length && !args.ip) return inRig;
  return [{ name: "sensor", ip: args.ip ?? DEFAULT_IP }];
}

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  let args: Args, store: Store;
  try {
    args = parse(argv);
    store = new Store(args.store, args.rig);
    sensorSpecs(args, store.rig);                          // a bad --sensor is reported before anything starts
  } catch (e) {
    console.error(`error: ${describeError(e)}`);
    process.exit(2);
  }
  /** the live sensors: --sensor / --ip, else the registry's (with an address, not disabled) */
  const liveSensors = () => (args.offline ? [] : sensorSpecs(args, { sensors: store.data.sensors.filter(s => s.enabled !== false) }))
    .map(s => new LiveSensor(s.name, { kind: "cola", ip: s.ip }, s.ip));
  const hub = new Hub(args.recordings, liveSensors(), 3, store.rig, rig => { store.rig = rig; }, store.processing);
  hub.maxProcessing = store.data.maxSessions;
  const clients = new Clients(hub, store, args.recordings);
  let polls = new Stop();
  const poll = () => {                                     // each live sensor's REST status
    polls.set(); polls = new Stop();
    for (const s of hub.live) void supervised(`${s.label} status poll`, () => statusLoop(new RestClient(s.ip, 3), s, polls), polls);
  };
  const app = createApp(hub, args.recordings, { frontendDir: args.frontend, store, onRegistry: () => { hub.setLive(liveSensors()); poll(); } });
  let server: ReturnType<typeof Bun.serve<Conn>>;
  try {                                                    // bind first: a busy port is reported in one line, nothing started
    server = Bun.serve<Conn>({
      hostname: args.host, port: args.port, idleTimeout: 30, websocket: clients.websocket,
      fetch: (req, srv) => (new URL(req.url).pathname === "/ws" ? (clients.upgrade(req, srv) ? undefined : new Response("expected a WebSocket", { status: 400 })) : app(req)),
    });
  } catch (e) {
    console.error(`error: cannot listen on ${args.host}:${args.port}: ${describeError(e)}`);
    process.exit(1);
  }
  hub.start();
  poll();
  if (args.record) hub.startRecording(args.record).catch(e => log(`cannot record to ${args.record}: ${describeError(e)}`));
  if (args.replay) {
    try { hub.defaultSession = hub.createSession(resolve(args.replay)).id; hub.session(hub.defaultSession).keep = true; } catch (e) {
      log(`cannot replay ${args.replay}: ${describeError(e)}`);
    }
  }
  const specs = hub.live.map(s => `${s.name} ${s.ip}`);
  const src = [args.offline ? "offline" : specs.length > 1 ? specs.join(", ") : specs.length ? `sensor ${hub.live[0].ip}` : "no sensors",
               ...(hub.defaultSession ? [`replaying ${args.replay}`] : [])].join("; ");
  log(`server on http://${args.host === "127.0.0.1" ? "localhost" : args.host}:${server.port}  (${src}; recordings in ${args.recordings}; WebSocket /ws)`);
  const quit = async () => { polls.set(); clients.close(); await hub.shutdown(); server.stop(true); process.exit(0); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

if (import.meta.main) void main();
