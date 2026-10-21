// Which Chromium the end-to-end test drives, in this order:
//  1. $CHROMIUM (explicit path)
//  2. a Chromium / Chrome on PATH
//  3. Playwright's own Chromium (`bunx playwright-core install chromium`, ~150 MB, cached per user)
// NixOS: 2 finds the system chromium; Playwright's download does not run there.
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { chromium } from "playwright-core";

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

export const pythonInVenv = (backendDir: string): string => join(backendDir, ".venv", "bin", "python");

/** the server the tests start: the Bun server (server/), or with BACKEND=python the Python backend it replaces */
export function serverCommand(root: string): string[] {
  if (process.env.BACKEND === "python") return [process.env.PYTHON ?? pythonInVenv(join(root, "backend")), "-m", "mrs6000.server"];
  return [process.env.BUN ?? "bun", join(root, "server", "src", "main.ts")];
}
