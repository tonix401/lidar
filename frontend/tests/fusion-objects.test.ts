// Fusing the sensors' objects (src/fusion/objects.ts) on the simulated rig with its true poses.
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/config";
import { ObjectFusion, observe, type Observation } from "../src/fusion/objects";
import { Processor } from "../src/pipeline/processor";
import { truth } from "./helpers/calib";
import { RIG3, ROOM, scanFrame, scanTime, simMeta, walker } from "./helpers/rig";
import { apply, compose, invert } from "../src/fusion/pose";

/** a person-sized cluster of points around (x, y) as seen from `from` (its near half) */
function person(x: number, y: number, from: number[], t: number, vx: number, sensor: number): Observation {
  const pts: number[] = [], a0 = Math.atan2(from[1] - y, from[0] - x);
  for (let k = 0; k < 40; k++) for (let z = 0.2; z < 1.0; z += 0.1) {
    const a = a0 + (k / 39 - 0.5) * Math.PI;
    pts.push(x + 0.2 * Math.cos(a), y + 0.2 * Math.sin(a), z);
  }
  return { sensor, track: 1, t, points: Float32Array.from(pts), vx, vy: 0, from, clipped: false };
}

describe("object fusion", () => {
  it("moves each sensor's points to the common time before merging", () => {
    const c = defaultConfig().objects, f = new ObjectFusion(), v = 1.5;
    for (let k = 0; k < 10; k++) {
      const t = 10 + 0.1 * k, ta = t - 0.05;                         // sensor a scanned 50 ms earlier
      f.update([person(v * ta, 0, [-3, -3, 1], ta, v, 0), person(v * t, 0, [3, 3, 1], t, v, 1)], t, c);
    }
    expect(f.confirmed).toHaveLength(1);
    const tr = f.confirmed[0];
    expect(Math.abs(tr.x - v * 10.9)).toBeLessThan(0.05);           // the axis, not the visible sides
    expect(Math.abs(tr.y)).toBeLessThan(0.05);
    expect(f.objects[0].sensors).toEqual([0, 1]);
    expect(f.ownerOf(0, 1)).toBe(tr.id);
  });

  it("gives one world track for a person all three sensors track", { timeout: 60_000 }, () => {
    const cfg = defaultConfig(), procs = RIG3.map(() => new Processor(cfg)), fusion = new ObjectFusion();
    const poses = RIG3.map(s => truth(s)), world = compose(poses[0], invert(RIG3[0].pose));   // sim world → calibration world
    const latest: Observation[][] = RIG3.map(() => []);
    let frames = 0, single = 0, perSensor = 0;
    const err: number[] = [], seen: number[] = [];
    for (let k = 0; k < 300; k++) RIG3.forEach((s, j) => {
      const t = scanTime(s, k), p = procs[j];
      p.ingest(scanFrame({ ...s, noise: 0.01, seed: j + 1 }, ROOM, t, k), simMeta(s, t, k + 1));
      latest[j] = observe(j, poses[j], t, p.objects!, p.grid!);
      if (j !== 0) return;                                          // tick on the first sensor's scans
      fusion.update(latest.flat(), t, cfg.objects);
      if (t < 8) return;                                            // warm-up: background, then the walker confirmed
      frames++;
      perSensor += procs.reduce((a, q) => a + q.objects!.confirmed.length, 0);
      const conf = fusion.confirmed;
      if (conf.length === 1) {
        single++;
        const [w] = walker()(t), q = apply(world, [w.x, w.y, 0]);
        err.push(Math.hypot(conf[0].x - q[0], conf[0].y - q[1]));
        const fo = fusion.objects.find(o => o.track === conf[0]);    // none while it coasts
        if (fo) seen.push(fo.sensors.length);
      }
    });
    expect(perSensor / frames).toBeGreaterThan(2);                  // the sensors each track it...
    expect(single / frames).toBeGreaterThan(0.95);                  // ...the fusion has one object
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
    expect(med(err)).toBeLessThan(0.08);
    expect(med(seen)).toBeGreaterThanOrEqual(2);
  });
});
