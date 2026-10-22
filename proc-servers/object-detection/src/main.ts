// An object-detection server: one configuration of the filter chain over the source server's sensors, serving fused
// world tracks to its clients. Each runs from its own settings database; several run side by side.
//
//   bun proc-servers/object-detection/src/main.ts                       data/default.db → http://localhost:8020 at first
//   bun proc-servers/object-detection/src/main.ts --db data/lobby.db    another server ("lobby"; give it its own port on its page)
//
// Everything else is a setting, in the database and on the server's page (store.ts, settings.ts): the source server,
// where it listens, the processing, the track cache, the clients, access. A new database data/<name>.db starts as a
// copy of empty.db.
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { describeError } from "@mrs6000/server-common/errors";
import { Listener } from "@mrs6000/server-common/listener";
import { log } from "@mrs6000/server-common/log";
import { Hub } from "./hub";
import { createApp } from "./http";
import { applySettings, cacheRoot, sourceAddress } from "./settings";
import { Store } from "./store";
import { Clients, type Conn } from "./ws";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), ".."), REPO = resolve(HERE, "../..");
const WEB = resolve(REPO, "clients/object-detection/dist");

export interface Args { db: string }

export function parse(argv: string[]): Args {
  const { values: v } = parseArgs({
    args: argv, strict: true, allowPositionals: false,
    options: { db: { type: "string", default: resolve(HERE, "data/default.db") }, help: { type: "boolean", default: false } },
  });
  if (v.help) {
    console.log("usage: object-detection [--db data/default.db]\n  every other setting is in the database, edited on the server's page");
    process.exit(0);
  }
  return { db: resolve(v.db!) };
}

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  let args: Args, store: Store;
  try {
    args = parse(argv);
    const name = basename(args.db, ".db");
    store = new Store(args.db, name, resolve(HERE, "empty.db"));
  } catch (e) {
    console.error(`error: ${describeError(e)}`);
    process.exit(2);
  }
  const d = store.data;
  const hub = new Hub(d.name, sourceAddress(d), store.processing, cacheRoot(REPO, d));
  hub.maxProcessing = d.maxSessions;
  const clients = new Clients(hub, store);
  let listener: Listener<Conn>;
  const app = createApp(hub, store, clients, WEB, b => {
    const out = applySettings(hub, store, listener, REPO, b);
    if (out.moved) log(`object detection "${d.name}" moved to ${listener.url}`);
    return out;
  });
  try {
    listener = new Listener<Conn>(at => Bun.serve<Conn>({
      hostname: at.host, port: at.port, idleTimeout: 30, websocket: clients.websocket,
      fetch: (req, srv) => {
        if (new URL(req.url).pathname !== "/ws") return app(req);
        const up = clients.upgrade(req, srv);
        return up === true ? undefined : up === false ? new Response("expected a WebSocket", { status: 400 }) : up;
      },
    }), { host: d.host, port: d.port });
  } catch (e) {
    console.error(`error: cannot listen on ${d.host}:${d.port} (settings in ${args.db}): ${describeError(e)}`);
    process.exit(1);
  }
  hub.start();
  log(`object detection "${d.name}" on ${listener.url}  (source ${d.source.url}; clients on /ws; settings in ${args.db})`);
  const quit = async () => { clients.close(); await hub.shutdown(); listener.stop(); process.exit(0); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

if (import.meta.main) void main();
