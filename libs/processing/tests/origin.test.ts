// Moving the world's origin to another sensor: a rigid change that leaves the sensors' places relative to each other.
import { describe, expect, it } from "vitest";
import { levelledFrame, moveOrigin, moveRegion, moveRigOrigin, worldChange } from "../src/fusion/calib/origin";
import { pointInPolygon, type Region } from "../src/fusion/calib/region";
import { apply, compose, fromParams, invert, poseError, toParams } from "../src/fusion/pose";
import { RIG3 } from "../sim/rig";
import { truth } from "../sim/calib";

const poses = RIG3.map(s => truth(s));

describe("moveOrigin", () => {
  it("puts the chosen sensor at x = y = yaw = 0, keeping its height and tilt", () => {
    const [, b] = moveOrigin(poses, 1).map(toParams), was = toParams(poses[1]);
    expect([b.x, b.y, b.yaw].map(v => Math.abs(v) < 1e-9)).toEqual([true, true, true]);
    expect([b.z, b.pitch, b.roll].map(v => +v.toFixed(6))).toEqual([was.z, was.pitch, was.roll].map(v => +v.toFixed(6)));
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

  it("is undone by moving back, and the first sensor as origin changes nothing", () => {
    const e0 = moveOrigin(poses, 0).map((p, i) => poseError(p, poses[i]));
    expect(e0.every(e => e.dist < 1e-9 && e.angle < 1e-4)).toBe(true);
    const back = moveOrigin(moveOrigin(poses, 2), 0).map((p, i) => poseError(p, poses[i]));
    expect(back.every(e => e.dist < 1e-9 && e.angle < 1e-4)).toBe(true);
  });

  it("levelledFrame has no tilt and sits on the floor", () => {
    const f = toParams(levelledFrame(poses[1]));
    expect([f.z, f.pitch, f.roll]).toEqual([0, 0, 0]);
  });
});

describe("the new origin's own floor", () => {
  const own = (i: number) => { const p = toParams(poses[i]); return { pitch: p.pitch, roll: p.roll, height: p.z }; };

  it("stands the sensor at its own floor's level pose, whatever tilt the old world gave it", () => {
    const floor = { pitch: 0.4, roll: -0.2, height: 1.1 };                       // not what the old world has for it
    const m = moveOrigin(poses, 1, floor).map(toParams)[1];
    expect([m.x, m.y, m.yaw].map(v => Math.abs(v) < 1e-9)).toEqual([true, true, true]);
    expect([m.z, m.pitch, m.roll].map(v => +v.toFixed(6))).toEqual([1.1, 0.4, -0.2]);
  });

  it("keeps the others' places relative to it, and so the world turns with the floor", () => {
    const floor = { pitch: 0.4, roll: -0.2, height: 1.1 }, m = moveOrigin(poses, 1, floor);
    for (const [i, j] of [[0, 1], [1, 2], [0, 2]]) {
      const e = poseError(compose(invert(poses[i]), poses[j]), compose(invert(m[i]), m[j]));
      expect(e.dist).toBeLessThan(1e-9);
      expect(e.angle).toBeLessThan(1e-4);
    }
    expect(toParams(m[0]).pitch).not.toBeCloseTo(toParams(moveOrigin(poses, 1)[0]).pitch, 1);   // not the old up any more
  });

  it("a floor that matches the old world's tilt gives the same as not knowing it", () => {
    const a = moveOrigin(poses, 2, own(2)), b = moveOrigin(poses, 2);
    a.forEach((p, i) => { const e = poseError(p, b[i]); expect(e.dist).toBeLessThan(1e-6); expect(e.angle).toBeLessThan(1e-3); });
  });
});

describe("a region follows the world", () => {
  it("covers the same things after the move", () => {
    const region: Region = [[-1, -2], [6, -2], [6, 4], [-1, 4]], inv = worldChange(poses[1]), moved = moveRegion(region, inv);
    for (const p of [[0, 0, 0], [3, 1, 0], [5.5, 3.5, 0], [-2, 0, 0], [7, 1, 0], [3, 5, 0]]) {
      const q = apply(inv, p);
      expect(pointInPolygon(q[0], q[1], moved), String(p)).toBe(pointInPolygon(p[0], p[1], region));
    }
  });
});

describe("moveRigOrigin", () => {
  const sensors = RIG3.map((s, i) => ({ name: s.name, pose: toParams(poses[i]), ...(i === 2 ? { region: [[0, 0], [4, 0], [4, 4]] as Region } : {}) }));

  it("gives the stored form: the new origin at zero, others moved, the region moved with them, unplaced sensors left out", () => {
    const out = moveRigOrigin([...sensors, { name: "x" }], "b");
    expect(out.map(s => s.name)).toEqual(["a", "b", "c"]);
    expect(out[1].pose).toMatchObject({ x: 0, y: 0, yaw: 0 });
    expect(Object.is(out[1].pose.x, -0)).toBe(false);
    expect(out[0].region).toBeUndefined();
    expect(out[2].region).toHaveLength(3);
    const e = poseError(compose(invert(fromParams(out[0].pose)), fromParams(out[2].pose)), compose(invert(poses[0]), poses[2]));
    expect(e.dist).toBeLessThan(2e-4);                                   // rounding of the stored form only
  });

  it("uses the sensor's stored own floor", () => {
    const withFloor = sensors.map((s, i) => (i === 1 ? { ...s, floor: { pitch: 0.4, roll: -0.2, height: 1.1 } } : s));
    expect(moveRigOrigin(withFloor, "b")[1].pose).toEqual({ x: 0, y: 0, z: 1.1, yaw: 0, pitch: 0.4, roll: -0.2 });
  });

  it("refuses a sensor without a pose", () => {
    expect(() => moveRigOrigin([...sensors, { name: "x" }], "x")).toThrow(/no pose/);
    expect(() => moveRigOrigin(sensors, "nope")).toThrow(/no pose/);
  });
});
