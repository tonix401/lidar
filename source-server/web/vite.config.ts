import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// the source server's management page: dev on http://localhost:5174 with /api proxied to the source server at the
// address in its settings database (make dev); build → dist/ (served by the source server at /). The proxy keeps the
// page's Host, so the server sees its own page.
const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
/** the server's URL, from its settings database (its default port before it has one) */
function server(): string {
  const r = spawnSync("bun", [at("../../libs/server-common/scripts/listen.ts"), at("../data/source.db"), "8000"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : "http://127.0.0.1:8000";
}

export default defineConfig(({ command }) => {
  const api = command === "serve" && !process.env.VITEST ? server() : "";       // only the dev server proxies
  return {
    server: { port: 5174, ...(api ? { proxy: { "/api": { target: api } } } : {}) },
    build: { outDir: "dist", emptyOutDir: true },
  };
});
