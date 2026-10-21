import { describe, expect, it } from "vitest";
import { DEG } from "../src/core/math";
import { apply, applyAll, compose, fromParams, fromRotationVector, invert, poseError, toParams } from "../src/fusion/pose";
import { castScan, RIG3, ROOM, simGeometry } from "../sim/rig";
import { elevations } from "../sim/scene";

describe("pose", () => {
  const p = { x: 1.5, y: -2, z: 0.9, yaw: 123, pitch: -7, roll: 4 };

  it("params round-trip", () => {
    const q = toParams(fromParams(p));
    for (const k of Object.keys(p) as (keyof typeof p)[]) expect(q[k]).toBeCloseTo(p[k], 9);
  });

  it("R is a rotation: Rz(yaw) Ry(pitch) Rx(roll)", () => {
    const { R } = fromParams({ x: 0, y: 0, z: 0, yaw: 90, pitch: 0, roll: 0 });
    expect(apply({ R, t: [0, 0, 0] }, [1, 0, 0]).map(v => +v.toFixed(12))).toEqual([0, 1, 0]);   // forward → left
    const pitched = fromParams({ x: 0, y: 0, z: 0, yaw: 0, pitch: 10, roll: 0 });
    expect(apply(pitched, [1, 0, 0])[2]).toBeCloseTo(-Math.sin(10 * DEG), 12);                     // positive pitch tilts the nose down
  });

  it("compose and invert", () => {
    const a = fromParams(p), b = fromParams({ x: -0.3, y: 0.2, z: 0.1, yaw: -40, pitch: 3, roll: -2 });
    const v = [0.7, -1.1, 2.3];
    expect(apply(compose(a, b), v)).toEqual(apply(a, apply(b, v)).map(x => expect.closeTo(x, 12)));
    expect(apply(compose(invert(a), a), v)).toEqual(v.map(x => expect.closeTo(x, 12)));
    expect(poseError(a, a).dist).toBe(0);
    expect(poseError(a, compose(a, fromRotationVector(0, 0, 2 * DEG))).angle).toBeCloseTo(2, 9);
  });

  it("applyAll matches apply", () => {
    const a = fromParams(p), pts = new Float32Array([1, 2, 3, -4, 5, -6]);
    const out = applyAll(a, pts, 2, new Float32Array(6));
    expect(Array.from(out.subarray(3))).toEqual(apply(a, [-4, 5, -6]).map(x => expect.closeTo(x, 5)));
  });
});

describe("simulated rig", () => {
  it("floor returns of every sensor land on z = 0 in the world", () => {
    for (const s of RIG3) {
      const { L, B, az0, step } = simGeometry(s), el = elevations(L), d = castScan(s, ROOM, 0);
      let floor = 0, below = 0;
      for (let l = 0; l < 3; l++) for (let b = 0; b < B; b++) {           // lowest layers: mostly floor
        const r = d[l * B + b]; if (!r) continue;
        const az = (az0 + b * step) * DEG, e = el[l] * DEG;
        const w = apply(s.pose, [r * Math.cos(az) * Math.cos(e), r * Math.sin(az) * Math.cos(e), r * Math.sin(e)]);
        if (Math.abs(w[2]) < 1e-4) floor++;                              // float32 ranges: ~1e-6 m
        if (w[2] < -1e-4) below++;
      }
      expect(floor, s.name).toBeGreaterThan(B);
      expect(below).toBe(0);
    }
  });

  it("the walker is seen by every sensor", () => {
    for (const s of RIG3) {
      const empty = castScan(s, { ...ROOM, people: () => [] }, 10), withP = castScan(s, ROOM, 10);
      let nearer = 0;
      for (let i = 0; i < empty.length; i++) if (withP[i] && (!empty[i] || withP[i] < empty[i] - 0.1)) nearer++;
      expect(nearer, s.name).toBeGreaterThan(100);
    }
  });
});

describe("frame sync", () => {
  it("draws a set once every sending sensor has a scan", async () => {
    const { FrameSync } = await import("../src/fusion/sync");
    const s = new FrameSync(150), all = [0, 1, 2];
    expect(s.add(0, 0, all)).toEqual([]);
    expect(s.add(2, 30, all)).toEqual([]);
    expect(s.add(1, 60, all)).toEqual([0, 1, 2]);
    expect(s.poll(1000)).toEqual([]);                              // nothing left over
  });

  it("does not wait for a silent sensor longer than maxWait", async () => {
    const { FrameSync } = await import("../src/fusion/sync");
    const s = new FrameSync(150);
    expect(s.add(0, 0, [0, 1, 2])).toEqual([]);
    expect(s.add(1, 40, [0, 1, 2])).toEqual([]);
    expect(s.poll(100)).toEqual([]);
    expect(s.poll(150)).toEqual([0, 1]);
    expect(s.add(0, 200, [0, 1])).toEqual([]);                     // c dropped out of the sending ones
    expect(s.add(1, 230, [0, 1])).toEqual([0, 1]);
  });

  it("keeps waiting when one sensor's next scan comes first", async () => {
    const { FrameSync } = await import("../src/fusion/sync");
    const s = new FrameSync(150);
    s.add(0, 0, [0, 1]);
    expect(s.add(0, 100, [0, 1])).toEqual([]);                     // 1 is late: 0's newer scan stays in the set
    expect(s.add(1, 120, [0, 1])).toEqual([0, 1]);
  });
});
