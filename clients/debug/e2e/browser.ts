// Which Chromium the end-to-end test drives, in this order:
//  1. $CHROMIUM (explicit path)
//  2. a Chromium / Chrome on PATH
//  3. Playwright's own Chromium (`bunx playwright-core install chromium`, ~150 MB, cached per user)
// NixOS: 2 finds the system chromium; Playwright's download does not run there.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { chromium } from "playwright-core";
import { seedDb, startSource } from "@mrs6000/server-common/testing";

const NAMES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"];

export function findBrowser(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
  if (env.CHROMIUM) return env.CHROMIUM;
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean))
    for (const name of NAMES) {
      const p = join(dir, name);
      if (exists(p)) return p;
    }
  return undefined;
}

/** executable path to launch, or undefined for Playwright's own browser (if installed) */
export function browserExecutable(): string | undefined {
  const found = findBrowser();
  if (found) return found;
  if (existsSync(chromium.executablePath())) return undefined;
  throw new Error("no Chromium found: install Chrome/Chromium, set CHROMIUM=/path/to/chrome, " +
                  "or run `make browser` (bunx playwright-core install chromium)");
}

/** the servers the tests start: a source server (offline, these recordings) and the debug server on top, serving
 *  the built page; `replay`: a recording every page opens first */
export async function startServers(root: string, recordings: string, replay?: string): Promise<{ base: string; source: string; log: () => string; stop(): void }> {
  const src = await startSource(recordings), port = await freePort(), db = join(mkdtempSync(join(tmpdir(), "debug-db-")), "debug.db");
  seedDb(db, { port, source: { url: src.url, token: "" }, replay: replay ?? "" });
  const debug = spawn(process.env.BUN ?? "bun", [join(root, "proc-servers", "debug", "src", "main.ts"), "--db", db]);
  let log = "";
  debug.stdout!.on("data", d => { log += d; });
  debug.stderr!.on("data", d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let k = 0; k < 100; k++) {
    try { if ((await fetch(base + "/api/state")).ok && (!replay || (await (await fetch(base + "/api/state")).json() as { default_session?: string }).default_session)) break; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return { base, source: src.url, log: () => src.log() + log, stop: () => { debug.kill(); src.stop(); } };
}

export const freePort = (): Promise<number> => new Promise(res => { const s = createServer(); s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
