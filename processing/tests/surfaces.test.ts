// One wall from several sensors (src/fusion/surfaces.ts), on the simulated rig.
import { describe, expect, it } from "vitest";
import { mergeSurfaces, type SurfaceInput } from "../src/fusion/surfaces";
import { apply, compose, fromParams } from "../src/fusion/pose";
import { EMPTY, rays } from "../sim/calib";
import { castScan, RIG3, type SimSensor } from "../sim/rig";

/** a sensor as the page would have it: believed pose (maybe off), static ranges with 3 mm noise */
function input(s: SimSensor, believed = s.pose): SurfaceInput {
  const { rx, ry, rz, L, B } = rays(s);
  return { pose: believed, L, B, rayX: rx, rayY: ry, rayZ: rz, range: castScan({ ...s, noise: 0.003 }, EMPTY, 0) };
}

/** world points of the back wall (y = 3.2) per beam, from the given ranges (null elsewhere) */
const wallY = (inp: SurfaceInput, r: Float32Array) => Array.from(r, (d, i) => {
  if (!(d > 0)) return null;
  const w = apply(inp.pose, [inp.rayX[i] * d, inp.rayY[i] * d, inp.rayZ[i] * d]);
  return Math.abs(w[1] - 3.2) < 0.06 && w[2] > 0.1 ? w : null;
});

describe("merging surfaces", () => {
  const [a, b] = RIG3, off = fromParams({ x: 0, y: 0.015, z: 0, yaw: 0, pitch: 0, roll: 0 });
  const ins = [input(a), input(b, compose(off, b.pose))];             // b believed 1.5 cm off: two walls
  const [ma, mb] = mergeSurfaces(ins);
  const mean = (v: number[]) => v.reduce((x, y) => x + y, 0) / v.length;

  it("puts both sensors' points of a shared wall on one surface", () => {
    const before = [ins[0].range, ins[1].range].map((r, k) => mean(wallY(ins[k], r).flatMap((w, i) => (w && [ma, mb][k].fused[i] ? [w[1]] : []))));
    const after = [ma, mb].map((m, k) => mean(wallY(ins[k], m.fused).flatMap(w => (w ? [w[1]] : []))));
    expect(Math.abs(before[1] - before[0])).toBeGreaterThan(0.012);
    console.log(`back wall, b vs a: ${((before[1] - before[0]) * 1000).toFixed(1)} mm before, ${((after[1] - after[0]) * 1000).toFixed(1)} mm after`);
    expect(Math.abs(after[1] - after[0])).toBeLessThan(0.002);
    expect(ma.shared).toBeGreaterThan(500);
  });

  it("shows each spot once (with a one-beam band at the seam), never not at all", () => {
    const cells = new Map<number, [number, number]>();                    // 10 cm along the wall × 10 cm high
    const drawn = (m: typeof ma, k: number) => m.fused.map((f, i) => f || ins[k].range[i]);   // not shared: as measured
    [ma, mb].forEach((m, k) => wallY(ins[k], drawn(m, k)).forEach((w, i) => {
      if (!w) return;
      const c = Math.floor(w[0] * 10) * 1000 + Math.floor(w[2] * 10), e = cells.get(c) ?? [0, 0];
      if (!m.hide[i]) e[k]++;
      cells.set(c, e);
    }));
    const shown = [...cells.values()];
    expect(shown.every(([x, y]) => x + y > 0)).toBe(true);
    console.log(`wall cells shown by both: ${(100 * shown.filter(([x, y]) => x > 0 && y > 0).length / shown.length).toFixed(0)} %`);
    expect(shown.filter(([x, y]) => x > 0 && y > 0).length / shown.length).toBeLessThan(0.25);   // both: the seam only
    expect(ma.hidden).toBeGreaterThan(100);
    expect(mb.hidden).toBeGreaterThan(100);
  });

  it("is fast enough to run every second at full resolution", () => {
    const full = RIG3.map(s => input({ ...s, B: 923, step: 0.1301 }));
    const t = performance.now();
    mergeSurfaces(full);
    console.log(`merge 3 × 24 × 923: ${(performance.now() - t).toFixed(0)} ms`);
    expect(performance.now() - t).toBeLessThan(400);
  });

  it("leaves what only one sensor sees alone", () => {
    const solo = mergeSurfaces([input(a)])[0];
    expect(solo.shared).toBe(0);
    expect(solo.hidden).toBe(0);
  });
});
