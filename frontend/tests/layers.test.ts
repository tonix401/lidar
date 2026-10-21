// Which folder of src/ may import which (see docs/architecture.md, "Layers"). The processing model is the
// @mrs6000/processing package (its own layer rules: processing/tests/layers.test.ts); here, the page's own
// folders on top of it.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../src"), PKG = "@mrs6000/processing/";
const ALLOWED: Record<string, string[]> = {
  render: ["processing"],
  worker: ["processing"],                           // the page's Web Workers: a Processor per sensor
  api: ["processing/core"],
  ui: ["processing", "render", "api:type"],         // the API only as types (calls go through callbacks)
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
}

/** the layer an import specifier points at: a folder of src/, or "processing/<folder>"; null for other packages */
function target(file: string, spec: string): string | null {
  if (spec.startsWith(PKG)) return "processing/" + spec.slice(PKG.length).split("/")[0];
  if (!spec.startsWith(".")) return null;
  return relative(SRC, resolve(dirname(file), spec)).split("/")[0];
}

describe("layers", () => {
  it("each folder only imports from the layers it may use", () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      const from = relative(SRC, f).split("/")[0];
      const allowed = ALLOWED[from];
      if (!allowed) continue;                                   // main.ts, app.ts, sensorView.ts: the composition root
      for (const m of readFileSync(f, "utf8").matchAll(/^(?:import|export)\s+(type\s+)?[^"']*?from\s+["']([^"']+)["']/gm)) {
        const t = target(f, m[2]), typeOnly = !!m[1];
        if (!t || t === from) continue;
        const ok = allowed.includes(t) || allowed.includes(t.split("/")[0]) || (typeOnly && allowed.includes(t + ":type"));
        if (!ok) bad.push(`${relative(SRC, f)} → ${t}${typeOnly ? " (type)" : ""}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the processing model is imported as the package, never by path", () => {
    const bad = files(SRC).filter(f => /from\s+["'](\.\.\/)+processing\//.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});
