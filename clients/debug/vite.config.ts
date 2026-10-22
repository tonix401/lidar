import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// dev: http://localhost:5173 with /api proxied to the debug server at the address in its settings database (make dev);
// build → dist/ (served by the debug server). The proxy keeps the page's Host, so the server sees its own page.
const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
/** the server's URL, from its settings database (its default port before it has one) */
function server(): string {
  const r = spawnSync("bun", [at("../../libs/server-common/scripts/listen.ts"), at("../../proc-servers/debug/data/debug.db"), "8010"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : "http://127.0.0.1:8010";
}

export default defineConfig(({ command }) => {
  const api = command === "serve" && !process.env.VITEST ? server() : "";       // only the dev server proxies
  return {
    server: { port: 5173, ...(api ? { proxy: { "/api": { target: api } } } : {}) },
    build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1000 },
    worker: { format: "es" },                   // src/worker/worker.ts: one per sensor
    test: { include: ["tests/**/*.test.ts"], environment: "node" },
  };
});
