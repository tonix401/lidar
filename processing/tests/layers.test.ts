// Which folder of src/ may import which (see docs/architecture.md, "Layers"). The processing model runs in
// the server, in browser workers and in tests, so it never imports a DOM, three.js, the server or the page:
// only its own lower layers. The simulator (sim/) may use all of it; src/ never uses the simulator.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, ".."), SRC = join(ROOT, "src");
const ALLOWED: Record<string, string[]> = {
  core: [],
  config: ["core", "pipeline", "objects"],          // config, pipeline and objects form the processing model
  pipeline: ["core", "config", "objects"],
  objects: ["core", "config", "pipeline"],
  fusion: ["core", "config", "pipeline", "objects"],  // several sensors: on top of the processing model
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
}

const specs = (file: string) =>
  [...readFileSync(file, "utf8").matchAll(/^(?:import|export)\s+(?:type\s+)?[^"']*?from\s+["']([^"']+)["']/gm)].map(m => m[1]);

describe("layers", () => {
  it("each folder only imports from the layers it may use", () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      const from = relative(SRC, f).split("/")[0], allowed = ALLOWED[from];
      for (const s of specs(f)) {
        if (!s.startsWith(".")) { bad.push(`${relative(ROOT, f)} → ${s} (a package)`); continue; }
        const target = relative(SRC, resolve(dirname(f), s));
        const folder = target.split("/")[0];
        if (target.startsWith("..")) bad.push(`${relative(ROOT, f)} → ${s} (outside src)`);
        else if (folder !== from && !allowed?.includes(folder)) bad.push(`${relative(ROOT, f)} → ${folder}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every folder of src has its rules", () => {
    expect(readdirSync(SRC).filter(d => !(d in ALLOWED))).toEqual([]);
  });
});
