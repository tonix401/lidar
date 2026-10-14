import { defineConfig } from "vitest/config";

// browser smoke test: starts the real backend (offline, replaying a generated recording) and drives
// the built frontend in headless Chromium (see e2e/browser.ts for which one)
export default defineConfig({
  test: { include: ["e2e/**/*.e2e.ts"], testTimeout: 90_000, hookTimeout: 120_000, fileParallelism: false },
});
