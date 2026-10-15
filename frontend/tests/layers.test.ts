// Which folder of src/ may import which (see docs/architecture.md, "Layers"). Lower layers never import
// higher ones, so the processing runs and tests without a DOM, three.js or the server.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../src");
const ALLOWED: Record<string, string[]> = {
  core: [],
  config: ["core", "pipeline", "objects"],          // config, pipeline and objects form the processing model
  pipeline: ["core", "config", "objects"],
  objects: ["core", "config", "pipeline"],
  render: ["core", "config", "pipeline", "objects"],
  api: ["core"],
  ui: ["core", "config", "pipeline", "objects", "render", "api:type"],   // the API only as types (calls go through callbacks)
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
}

function imports(file: string): { target: string; typeOnly: boolean }[] {
  const out = [];
  for (const m of readFileSync(file, "utf8").matchAll(/^(?:import|export)\s+(type\s+)?[^"']*?from\s+["'](\.[^"']+)["']/gm))
    out.push({ target: relative(SRC, resolve(dirname(file), m[2])).split("/")[0], typeOnly: !!m[1] });
  return out;
}

describe("layers", () => {
  it("each folder only imports from the layers it may use", () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      const from = relative(SRC, f).split("/")[0];
      const allowed = ALLOWED[from];
      if (!allowed) continue;                                   // main.ts, app.ts, app/: the composition root
      for (const { target, typeOnly } of imports(f))
        if (target !== from && !allowed.includes(target) && !(typeOnly && allowed.includes(target + ":type")))
          bad.push(`${relative(SRC, f)} → ${target}${typeOnly ? " (type)" : ""}`);
    }
    expect(bad).toEqual([]);
  });
});
