// The cross-check (pipeline/crosscheck.ts) on the simulated rig with mixed pixels at outlines: the same scans
// through the pipeline with and without it, compared beam by beam with the true surfaces.
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/config";
import { compose, invert, type Pose } from "../src/fusion/pose";
import type { OtherSensor } from "../src/pipeline/crosscheck";
import type { Grid } from "../src/pipeline/grid";
import { Processor } from "../src/pipeline/processor";
import { truth } from "./helpers/calib";
import { castScan, RIG3, ROOM, scanFrame, scanTime, simMeta, simGeometry, type SimSensor } from "./helpers/rig";

function others(rig: SimSensor[], poses: Pose[], procs: Processor[], ts: number[], j: number, t: number): OtherSensor[] {
  return rig.flatMap((o, m) => {
    const g = procs[m].grid;
    if (m === j || !g) return [];
    const T = compose(invert(poses[m]), poses[j]), { az0, step } = simGeometry(o);
    return [{ R: T.R, t: T.t, L: g.L, B: g.B, az0, step, range: g.out, age: t - ts[m],
              layerSin: Float32Array.from({ length: g.L }, (_, l) => g.rayZ[l * g.B + (g.B >> 1)]) }];
  });
}

describe("cross-check with other sensors", () => {
  it("removes ghosts other sensors see through, keeps the real surfaces", { timeout: 120_000 }, () => {
    const rig = RIG3.map((s, k) => ({ ...s, noise: 0.01, mixed: 0.4, seed: k + 1 })), poses = rig.map(s => truth(s));
    const cfgOn = defaultConfig(), cfgOff = defaultConfig();
    cfgOff.crosscheck.on = false;
    const on = rig.map(() => new Processor(cfgOn)), off = rig.map(() => new Processor(cfgOff)), ts = rig.map(() => 0);
    const n = { scans: 0, input: 0, filteredOff: 0, filteredOn: 0, ghostsOff: 0, ghostsOn: 0, lost: 0, gained: 0, removedReal: 0, tracksOff: 0, tracksOn: 0 };
    for (let k = 0; k < 90; k++) rig.forEach((s, j) => {
      const t = scanTime(s, k), frame = scanFrame(s, ROOM, t, k), meta = simMeta(s, t, k + 1);
      on[j].others = others(rig, poses, on, ts, j, t);
      off[j].others = others(rig, poses, off, ts, j, t);        // given, but the stage is off
      const a = off[j].ingest(frame, meta), b = on[j].ingest(frame, meta);
      ts[j] = t;
      if (t < 4) return;                                         // warm-up: models, then the walker (from 3 s)
      const tr = castScan({ ...s, noise: 0, mixed: 0 }, ROOM, t);
      const ghost = (d: number, i: number) => d > 0 && (!(tr[i] > 0) || Math.abs(d - tr[i]) > 0.2);
      const ok = (d: number, i: number) => d > 0 && tr[i] > 0 && Math.abs(d - tr[i]) < 0.05;
      const count = (g: Grid, f: (d: number, i: number) => boolean, r: Float32Array) => { let c = 0; for (let i = 0; i < g.N; i++) if (f(r[i], i)) c++; return c; };
      n.scans++;
      n.input += count(a, ghost, a.rawIn);
      n.filteredOff += count(a, ghost, a.raw); n.filteredOn += count(b, ghost, b.raw);
      n.ghostsOff += count(a, ghost, a.out); n.ghostsOn += count(b, ghost, b.out);
      for (let i = 0; i < a.N; i++) {
        if (ok(a.out[i], i) && !(b.out[i] > 0)) n.lost++;              // the two runs drift apart a little (different
        if (ok(b.out[i], i) && !(a.out[i] > 0)) n.gained++;            // input to the temporal model): both ways
        if (b.seenThrough[i] && ok(a.out[i], i) && !(b.out[i] > 0)) n.removedReal++;   // what the check itself took
      }
      n.tracksOff += off[j].objects!.confirmed.length; n.tracksOn += on[j].objects!.confirmed.length;
    });
    const per = Object.fromEntries(Object.entries(n).filter(([k]) => k !== "scans").map(([k, v]) => [k, +(v / n.scans).toFixed(2)]));
    console.log("per scan and sensor:", JSON.stringify(per));
    expect(per.filteredOn).toBeLessThan(0.75 * per.filteredOff);     // after the filters: the scan the models learn from
    expect(per.ghostsOn).toBeLessThan(0.8 * per.ghostsOff);          // what is drawn
    expect(per.removedReal).toBeLessThan(0.05 * (per.ghostsOff - per.ghostsOn));   // real points it took: few per ghost
    expect(per.lost - per.gained).toBeLessThan(0.1 * (per.ghostsOff - per.ghostsOn));   // net, with the drift
    expect(per.tracksOn).toBe(per.tracksOff);
  });

  it("does nothing without other sensors", () => {
    const p = new Processor(defaultConfig()), s = RIG3[0];
    const g = p.ingest(scanFrame({ ...s, mixed: 0.4 }, ROOM, 0), simMeta(s, 0));
    expect(g.seenThrough.some(v => v)).toBe(false);
    expect(p.stats.seenThrough).toBe(0);
  });
});
