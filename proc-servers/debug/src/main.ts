// The debug server: relays the source server's raw frames to the debug page (clients/debug, which runs the whole
// pipeline itself) and keeps its own fused objects of them for comparison.
//
//   bun proc-servers/debug/src/main.ts                  the settings in data/debug.db → http://localhost:8010 at first
//   bun proc-servers/debug/src/main.ts --db other.db    another settings database
//
// Everything else is a setting, in the database and in the viewer's Server section (store.ts, settings.ts): the
// source server, where it listens, its own objects, a replay every page opens first, access. A new database takes
// over an older config/debug.json.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { describeError } from "@mrs6000/server-common/errors";
import { Listener } from "@mrs6000/server-common/listener";
import { log } from "@mrs6000/server-common/log";
import { Hub } from "./hub";
import { createApp } from "./http";
import { applySettings } from "./settings";
import { Store } from "./store";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), ".."), REPO = resolve(HERE, "../..");
const WEB = resolve(REPO, "clients/debug/dist");

export interface Args { db: string }

export function parse(argv: string[]): Args {
  const { values: v } = parseArgs({
    args: argv, strict: true, allowPositionals: false,
    options: { db: { type: "string", default: resolve(HERE, "data/debug.db") }, help: { type: "boolean", default: false } },
  });
  if (v.help) {
    console.log("usage: debug [--db data/debug.db]\n  every other setting is in the database, edited in the viewer's Server section");
    process.exit(0);
  }
  return { db: resolve(v.db!) };
}

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  let args: Args, store: Store;
  try {
    args = parse(argv);
    store = new Store(args.db, [resolve(HERE, "config/debug.json")]);
  } catch (e) {
    console.error(`error: ${describeError(e)}`);
    process.exit(2);
  }
  const d = store.data;
  const hub = new Hub({ url: d.source.url, token: d.source.token || undefined, name: d.name }, store.processing, d.objects);
  let listener: Listener;
  const app = createApp(hub, store, WEB, async b => {
    const out = await applySettings(hub, store, listener, b);
    if (out.moved) log(`debug server moved to ${listener.url}`);
    return out;
  });
  try {
    listener = new Listener(at => Bun.serve({ hostname: at.host, port: at.port, idleTimeout: 30, fetch: app }), { host: d.host, port: d.port });
  } catch (e) {
    console.error(`error: cannot listen on ${d.host}:${d.port} (settings in ${args.db}): ${describeError(e)}`);
    process.exit(1);
  }
  if (d.replay) await hub.setDefaultReplay(d.replay).catch(e => log(`cannot replay ${d.replay}: ${describeError(e)}`));
  log(`debug server on ${listener.url}  (source ${d.source.url}${hub.defaultSession ? `; replaying ${d.replay}` : ""}; settings in ${args.db})`);
  const quit = () => { hub.shutdown(); listener.stop(); process.exit(0); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

if (import.meta.main) void main();
