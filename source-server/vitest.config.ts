import { defineConfig } from "vitest/config";

// the source server's tests run in Bun (`bun --bun x vitest`): they use Bun.serve, Bun.connect and Bun's zstd
export default defineConfig({ test: { include: ["tests/**/*.test.ts"], environment: "node", testTimeout: 20_000 } });
