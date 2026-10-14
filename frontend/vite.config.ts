import { defineConfig } from "vitest/config";

// dev: http://localhost:5173 with /api proxied to the backend (make dev); build → dist/ (served by the backend)
export default defineConfig({
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8000" } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1000 },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
