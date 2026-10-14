import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/config";
import { Processor } from "../src/pipeline/processor";
import { buildGeometry, createGeometry, UNIFORM, type GeometryOptions } from "../src/render/geometry";
import { frameData, meta } from "./helpers/scene";

function processed(objects = [] as { x: number; y: number; r: number; z0: number; z1: number }[]) {
  const p = new Processor(defaultConfig());
  p.ingest(frameData({ objects }), meta());
  return p.grid!;
}
const opts: GeometryOptions = { colorBy: "uniform", layer: -1, maxRange: 60, jump: 0.3, jumpRel: 0.03 };

describe("geometry", () => {
  it("builds points, lines and a mesh over the whole visible surface", () => {
    const g = processed(), geo = buildGeometry(g, g.out, createGeometry(g.N), opts);
    const valid = Array.from(g.out).filter(v => v > 0).length;
    expect(geo.np).toBe(valid);
    expect(geo.nl).toBeGreaterThan(valid * 0.9);
    expect(geo.nt).toBeGreaterThan(valid * 1.5);
    const i = geo.pIdx[0];
    expect(Array.from(geo.col.slice(3 * i, 3 * i + 3))).toEqual(UNIFORM.map(v => Math.fround(v)));
    expect(Math.hypot(geo.nrm[3 * i], geo.nrm[3 * i + 1], geo.nrm[3 * i + 2])).toBeCloseTo(1, 5);
  });

  it("does not connect across depth jumps", () => {
    const g = processed([{ x: 2, y: 0, r: 0.3, z0: -1, z1: 2 }]), geo = buildGeometry(g, g.out, createGeometry(g.N), opts);
    for (let k = 0; k < geo.nl; k++) {
      const a = geo.lIdx[2 * k], b = geo.lIdx[2 * k + 1];
      expect(Math.abs(g.out[a] - g.out[b])).toBeLessThan(0.5);
    }
  });

  it("filters by layer and range, colours by distance with a tint", () => {
    const g = processed();
    const geo = buildGeometry(g, g.out, createGeometry(g.N), { ...opts, layer: 5, colorBy: "dist", tint: (i, rgb) => (i % 2 ? [0, 0, 0] : rgb) });
    for (let k = 0; k < geo.np; k++) expect(Math.floor(geo.pIdx[k] / g.B)).toBe(5);
    expect(geo.nt).toBe(0);
    expect(geo.hi).toBeGreaterThan(geo.lo);
    const odd = Array.from(geo.pIdx.slice(0, geo.np)).find(i => i % 2)!;
    expect(geo.col[3 * odd]).toBe(0);
    expect(buildGeometry(g, g.out, createGeometry(g.N), { ...opts, maxRange: 2 }).np).toBeLessThan(geo.np * 24);
  });

  it("area colouring counts classes", () => {
    const g = processed(), geo = buildGeometry(g, g.out, createGeometry(g.N), { ...opts, colorBy: "area" });
    expect(geo.areaCounts.reduce((a, b) => a + b, 0)).toBe(geo.np);
  });

  it("cell colouring: one colour per slot, grey without one", () => {
    const g = processed(), cells = new Int32Array(g.N).fill(-1);
    cells[0] = 5; cells[1] = 5; cells[2] = 6;
    const geo = buildGeometry(g, g.out, createGeometry(g.N), { ...opts, colorBy: "cell", cells });
    const rgb = (i: number) => Array.from(geo.col.subarray(3 * i, 3 * i + 3));
    expect(rgb(0)).toEqual(rgb(1));
    expect(rgb(0)).not.toEqual(rgb(2));
    expect(rgb(3)[0]).toBeCloseTo(UNIFORM[0] * 0.35);
    const off = buildGeometry(g, g.out, createGeometry(g.N), { ...opts, colorBy: "cell" });   // cells off
    expect(Array.from(off.col.subarray(0, 3))).toEqual(rgb(3));
  });
});
