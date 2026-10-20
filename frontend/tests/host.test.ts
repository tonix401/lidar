// The page's mirror of a sensor's processing (pipeline/host.ts, snapshot.ts): what a worker sends after a scan
// must give the page the same grid, objects and statistics as the Processor itself.
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/config";
import { ObjectDetector } from "../src/objects/detector";
import { createGrid } from "../src/pipeline/grid";
import { ProcessorHost } from "../src/pipeline/host";
import { Processor } from "../src/pipeline/processor";
import { applySnapshot, MIRRORED, MIRRORED_RAYS, snapshotBytes, takeSnapshot } from "../src/pipeline/snapshot";
import { frameData, meta } from "./helpers/scene";

/** a walk across the room: the background learned, then a tracked person */
function walk(p: { ingest(d: Float32Array, m: ReturnType<typeof meta>): unknown }, scans = 60) {
  for (let k = 0; k < scans; k++)
    p.ingest(frameData({ noise: 0.01, seed: k + 1, objects: k >= 25 ? [{ x: 3.5, y: -1.5 + 3 * k / scans, r: 0.25, z0: -1, z1: 0.8 }] : [] }),
             meta({}, { ts: 1000 + 0.1 * k, id: k + 1 }));
}

describe("processing mirror", () => {
  it("a snapshot carries what the page reads", () => {
    const cfg = defaultConfig();
    cfg.objects.learn = 2; cfg.cells.on = true;
    const p = new Processor(cfg);
    walk(p);
    const g = p.grid!, buf = new ArrayBuffer(snapshotBytes(g));
    const s = takeSnapshot(p, buf, true, false);
    const mg = createGrid(g.L, g.B), md = new ObjectDetector(g.N);
    const assign = applySnapshot(structuredClone(s), mg, md, null);
    for (const k of [...MIRRORED, ...MIRRORED_RAYS]) expect(Array.from(mg[k]), k).toEqual(Array.from(g[k]));
    expect(mg.frames).toBe(g.frames);
    expect(Array.from(md.cell)).toEqual(Array.from(p.objects!.cell));
    expect(Array.from(md.bgModel.bg)).toEqual(Array.from(p.objects!.bgModel.bg));
    expect(md.bgModel.ready).toBe(true);
    expect(md.confirmed.map(t => [t.id, t.x])).toEqual(p.objects!.confirmed.map(t => [t.id, t.x]));
    expect(md.confirmed.length).toBeGreaterThan(0);
    const id = md.confirmed[0].id;
    expect(md.tracker.byId(id)?.id).toBe(id);
    expect(Array.from(assign!)).toEqual(Array.from(p.cells!.assign));
    expect(s.stats).toEqual(p.stats);
  });

  it("without workers, the host runs the Processor on this thread", () => {
    const cfg = defaultConfig(), scans: boolean[] = [];
    cfg.objects.learn = 2;
    const h = new ProcessorHost(cfg, "upright", { scan: (_m, first) => scans.push(first), refined: () => {}, error: e => { throw e; } }, false);
    const p = new Processor(cfg);
    walk({ ingest: (d, m) => h.ingest(d, m, () => []) });
    walk(p);
    expect(scans.length).toBe(60);
    expect(scans[0]).toBe(true);
    expect(scans.slice(1).every(f => !f)).toBe(true);
    expect(Array.from(h.grid!.out)).toEqual(Array.from(p.grid!.out));
    const counts = (st: typeof p.stats) => { const { ingestMs: _i, refineMs: _r, ...rest } = st; return rest; };   // not the timings
    expect(counts(h.stats)).toEqual(counts(p.stats));
    expect(h.meta?.id).toBe(60);
  });
});
