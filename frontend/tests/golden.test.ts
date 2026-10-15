// Characterization test: the whole pipeline on a synthetic walk, reduced to checksums. Refactors must
// keep these snapshots; update them (vitest -u) only for intended behaviour changes.
import { describe, expect, it } from "vitest";
import { autoConfig } from "../src/config/auto";
import { defaultConfig, withPreset, type Config } from "../src/config/config";
import { Processor } from "../src/pipeline/processor";
import { frameData, meta } from "./helpers/scene";

/** FNV-1a over the bytes of a typed array */
function hash(a: ArrayBufferView): string {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

function run(cfg: Config, scans = 80, weak = 0) {
  cfg.objects.learn = 2;                                    // background ready within the walk
  const p = new Processor(cfg);
  for (let k = 0; k < scans; k++) {
    const x = 3.5, y = -1.5 + 3 * k / scans;                 // a person walking across, in front of the wall
    const data = frameData({ noise: 0.01, seed: k + 1, quantize: true, layerOffsets: Array.from({ length: 24 }, (_, l) => 0.01 * Math.sin(l)),
                             objects: k >= 30 ? [{ x, y, r: 0.25, z0: -1, z1: 0.8 }] : [] });
    if (weak) for (let i = data.length / 3; i < 2 * data.length / 3; i += weak) data[i] = 5;   // some weak returns
    p.ingest(data, meta({}, { ts: 1000 + k * 0.1, id: k + 1 }));
  }
  const g = p.grid!;
  const { ingestMs: _i, refineMs: _r, ...stats } = p.stats;
  return {
    out: hash(g.out), fill: hash(g.fill), front: hash(g.front), seesWall: hash(g.seesWall), area: hash(g.area),
    layerBias: hash(p.layerBias), stats: JSON.stringify(stats),
    tracks: (p.objects?.confirmed ?? []).map(t => `${t.id} ${t.cls} ${t.x.toFixed(4)} ${t.y.toFixed(4)}`),
  };
}

describe("golden pipeline output", () => {
  it("default config", () => expect(run(defaultConfig())).toMatchSnapshot());
  it("preset off", () => expect(run(withPreset(defaultConfig(), "off"))).toMatchSnapshot());
  it("preset strong", () => expect(run(withPreset(defaultConfig(), "strong"))).toMatchSnapshot());
  it("auto config", () => expect(run(autoConfig(defaultConfig(), 0.02))).toMatchSnapshot());
  it("intensity, cells on, walls off", () => {
    const c = defaultConfig();
    c.intensity = { on: true, min: 10, max: 300 }; c.cells.on = true; c.walls.on = false; c.outline.on = false;
    expect(run(c, 80, 37)).toMatchSnapshot();
  });
});
