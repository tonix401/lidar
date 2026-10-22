import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// dev: http://localhost:5175 with /api and /ws proxied to an object-detection server at the address in its settings
// database (make dev: data/$NAME.db); build → dist/ (served by the object-detection server). The proxy keeps the
// page's Host, so the server sees its own page.
const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
/** the server's URL, from its settings database (its default port before it has one) */
function server(): string {
  const db = process.env.OBJECTS_DB || at("../../proc-servers/object-detection/data/default.db");
  const r = spawnSync("bun", [at("../../libs/server-common/scripts/listen.ts"), db, "8020"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : "http://127.0.0.1:8020";
}

export default defineConfig(({ command }) => {
  const api = command === "serve" && !process.env.VITEST ? server() : "";       // only the dev server proxies
  return {
    server: { port: 5175, ...(api ? { proxy: { "/api": { target: api }, "/ws": { target: api.replace(/^http/, "ws"), ws: true } } } : {}) },
    build: { outDir: "dist", emptyOutDir: true },
    test: { include: ["tests/**/*.test.ts"], environment: "node" },
  };
});
