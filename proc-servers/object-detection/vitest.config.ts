import { defineConfig } from "vitest/config";

// the tests run in Bun (`bun --bun x vitest`): they start a source server and use Bun.serve
export default defineConfig({ test: { include: ["tests/**/*.test.ts"], environment: "node", testTimeout: 20_000 } });
