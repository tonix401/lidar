// Moving the world's origin to another sensor: the floor below it becomes the world's origin, rigidly, so the sensors
// keep their places relative to each other and the floor stays at z = 0.
import { describe, expect, it } from "vitest";
import { moveOrigin, moveRegion, moveRigOrigin, worldChange } from "../src/fusion/calib/origin";
import { pointInPolygon, type Region } from "../src/fusion/calib/region";
import { apply, compose, fromParams, invert, poseError, toParams } from "../src/fusion/pose";
import { RIG3 } from "../sim/rig";
import { truth } from "../sim/calib";

const poses = RIG3.map(s => truth(s));

describe("moveOrigin", () => {
  it("puts the chosen sensor above the origin, facing x, at its own height", () => {
    for (const o of [0, 1, 2]) {
      const p = toParams(moveOrigin(poses, o)[o]);
      expect([p.x, p.y, p.yaw].map(v => Math.abs(v) < 1e-9)).toEqual([true, true, true]);
      expect(p.z).toBeCloseTo(RIG3[o].pose.t[2], 9);
    }
  });

  it("keeps every height: the floor stays at z = 0", () => {
    for (const o of [0, 1, 2]) moveOrigin(poses, o).forEach((p, i) => expect(p.t[2]).toBeCloseTo(RIG3[i].pose.t[2], 9));
  });

  it("keeps every pair of sensors where it was relative to each other, for any choice", () => {
    for (const o of [0, 1, 2]) {
      const m = moveOrigin(poses, o);
      for (const [i, j] of [[0, 1], [1, 2], [0, 2]]) {
        const rel = (p: typeof poses) => compose(invert(p[i]), p[j]);
        const e = poseError(rel(poses), rel(m));
        expect(e.dist).toBeLessThan(1e-9);
        expect(e.angle).toBeLessThan(1e-4);   // acos near 1 loses half the digits
      }
    }
  });

  it("is undone by moving back", () => {
    const back = moveOrigin(moveOrigin(poses, 2), 0);
    back.forEach((p, i) => { const e = poseError(poses[i], p); expect(e.dist).toBeLessThan(1e-9); expect(e.angle).toBeLessThan(1e-4); });
  });
});

describe("a region follows the world", () => {
  it("covers the same things after the move", () => {
    const region: Region = [[-1, -2], [6, -2], [6, 4], [-1, 4]], W = worldChange(poses[1]), moved = moveRegion(region, W);
    for (const p of [[0, 0, 0], [3, 1, 0], [5.5, 3.5, 0], [-2, 0, 0], [7, 1, 0], [3, 5, 0]]) {
      const q = apply(W, p);
      expect(pointInPolygon(q[0], q[1], moved), String(p)).toBe(pointInPolygon(p[0], p[1], region));
    }
  });
});

describe("moveRigOrigin", () => {
  const sensors = RIG3.map((s, i) => ({ name: s.name, pose: toParams(poses[i]), ...(i === 2 ? { region: [[0, 0], [4, 0], [4, 4]] as Region } : {}) }));

  it("gives the stored form: the new origin at zero, others moved, the region moved with them, unplaced sensors left out", () => {
    const out = moveRigOrigin([...sensors, { name: "x" }], "b");
    expect(out.map(s => s.name)).toEqual(["a", "b", "c"]);
    expect(out[1].pose).toEqual({ x: 0, y: 0, z: 1.6, yaw: 0 });
    expect(out[0].region).toBeUndefined();
    expect(out[2].region).toHaveLength(3);
    const e = poseError(compose(invert(fromParams(out[0].pose)), fromParams(out[2].pose)), compose(invert(poses[0]), poses[2]));
    expect(e.dist).toBeLessThan(2e-4);                                   // rounding of the stored form only
  });

  it("refuses a sensor without a pose", () => {
    expect(() => moveRigOrigin([...sensors, { name: "x" }], "x")).toThrow(/no pose/);
    expect(() => moveRigOrigin(sensors, "nope")).toThrow(/no pose/);
  });
});
