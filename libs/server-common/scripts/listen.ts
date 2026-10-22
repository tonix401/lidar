// bun scripts/listen.ts <database> <default port>: the URL a server with this settings database listens on, for
// the Vite dev servers' proxies (a server listening on every address is reached on this machine's).
import { existsSync } from "node:fs";
import { SettingsDb } from "../src/settings";

const [path, port] = Bun.argv.slice(2);
const v = path && existsSync(path) ? new SettingsDb(path).load() : {};
const host = typeof v.host === "string" && v.host && v.host !== "0.0.0.0" && v.host !== "::" ? v.host : "127.0.0.1";
console.log(`http://${host.includes(":") ? `[${host}]` : host}:${typeof v.port === "number" ? v.port : Number(port)}`);
