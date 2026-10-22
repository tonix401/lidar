// For tests and tools of the processing servers: a source server of its own, as a separate process (the projects
// never import each other), offline, on a free port, with its recordings in `recordings` and a settings database of
// its own (more `settings` seeded into it).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface TestSource { url: string; proc: ChildProcess; log: () => string; stop(): void }

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_MAIN = resolve(HERE, "../../../source-server/src/main.ts"), SEED = resolve(HERE, "../scripts/seed.ts");

/** a server's settings database with these values, written before the server starts (in a child process: the
 *  database is bun:sqlite, which a page's tests have no types for) */
export function seedDb(path: string, values: Record<string, unknown>): void {
  const r = spawnSync(process.env.BUN ?? "bun", [SEED, path, JSON.stringify(values)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cannot seed ${path}: ${r.stderr || r.error}`);
}

export async function startSource(recordings: string, settings: Record<string, unknown> = {}): Promise<TestSource> {
  const db = join(mkdtempSync(join(tmpdir(), "source-db-")), "source.db");
  seedDb(db, { port: 0, recordings: resolve(recordings), ...settings });
  const proc = spawn(process.env.BUN ?? "bun", [SOURCE_MAIN, "--offline", "--db", db]);
  let out = "";
  proc.stdout!.on("data", d => { out += d; });
  proc.stderr!.on("data", d => { out += d; });
  const end = performance.now() + 15_000;
  for (;;) {
    const m = out.match(/source server on http:\/\/localhost:(\d+)/);
    if (m) return { url: `http://127.0.0.1:${m[1]}`, proc, log: () => out, stop: () => { proc.kill(); } };
    if (proc.exitCode !== null || performance.now() > end) { proc.kill(); throw new Error(`source server did not start:\n${out}`); }
    await new Promise(r => setTimeout(r, 50));
  }
}
