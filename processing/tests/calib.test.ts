// Calibration on the simulated rig (sim/rig.ts), whose true poses are known.
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/config";
import { DEG } from "../src/core/math";
import { fitFloor, levelPose } from "../src/fusion/calib/floor";
import { icp, mergeClouds, transformCloud } from "../src/fusion/calib/icp";
import { Calibrator } from "../src/fusion/calib/calibrator";
import { calibrateRig, rigEntry } from "../src/fusion/calib/rig";
import { alignWalks, walkSample } from "../src/fusion/calib/walk";
import { kabsch2d, solve, symEigen } from "../src/fusion/linalg";
import { apply, compose, fromParams, poseError, toParams } from "../src/fusion/pose";
import { Processor } from "../src/pipeline/processor";
import { cloudOf, detections, truth } from "../sim/calib";
import { RIG3, ROOM, scanFrame, scanTime, simMeta, toSensor, type Room, type SimSensor } from "../sim/rig";

describe("linalg", () => {
  it("solves, decomposes, aligns", () => {
    expect(solve([2, 1, 1, 3], [3, 5], 2)!.map(v => +v.toFixed(12))).toEqual([0.8, 1.4]);
    expect(solve([1, 2, 2, 4], [1, 1], 2)).toBeNull();
    const { values, vectors } = symEigen([4, 1, 0, 1, 3, 0, 0, 0, 1], 3);
    expect(values[0]).toBeCloseTo(1, 12);
    expect(values[2]).toBeCloseTo((7 + Math.sqrt(5)) / 2, 12);
    expect(Math.abs(vectors[0][2])).toBeCloseTo(1, 12);
    const from = [[0, 0], [1, 0], [0, 2]], th = 0.7;
    const to = from.map(([x, y]) => [Math.cos(th) * x - Math.sin(th) * y + 3, Math.sin(th) * x + Math.cos(th) * y - 1]);
    const k = kabsch2d(from, to);
    expect([k.theta, k.tx, k.ty].map(v => +v.toFixed(10))).toEqual([0.7, 3, -1]);
  });
});

describe("floor", () => {
  it("gives every sensor's tilt within 0.1° and height within 1 cm", () => {
    for (const s of RIG3) {
      const cl = cloudOf(s), f = fitFloor(cl)!, p = toParams(s.pose);
      expect(f, s.name).not.toBeNull();
      expect(Math.abs(f.pitch - p.pitch)).toBeLessThan(0.1);
      expect(Math.abs(f.roll - p.roll)).toBeLessThan(0.1);
      expect(Math.abs(f.height - p.z)).toBeLessThan(0.01);
      // levelled: the floor lies at z = 0
      // levelled, nothing lies below the floor
      const lv = levelPose(f);
      for (let i = 0; i < cl.count; i++) expect(apply(lv, cl.p.subarray(3 * i, 3 * i + 3))[2]).toBeGreaterThan(-0.02);
    }
  });

  it("finds none without a floor in view", () => {
    const up = { ...RIG3[0], pose: fromParams({ x: -3, y: -2, z: 1, yaw: 38, pitch: -20, roll: 0 }) };   // looking up
    expect(fitFloor(cloudOf(up))).toBeNull();
  });
});

describe("walk alignment", () => {
  it("finds the clock offset, position and yaw of one sensor relative to another", () => {
    const [a, b] = RIG3, lvA = levelPose(fitFloor(cloudOf(a))!), lvB = levelPose(fitFloor(cloudOf(b))!);
    const wa = detections(a).map(d => walkSample(d, d.t, lvA)), wb = detections(b, 0.137, 40, 2).map(d => walkSample(d, d.t, lvB));
    const al = alignWalks(wa, wb)!;
    expect(al.dt).toBeCloseTo(0.137, 2);                        // within 5 ms
    const est = compose(fromParams({ x: al.tx, y: al.ty, z: 0, yaw: al.theta / DEG, pitch: 0, roll: 0 }), lvB);
    const e = poseError(est, truth(b));
    expect(e.dist).toBeLessThan(0.03);
    expect(e.angle).toBeLessThan(0.3);
    expect(al.spread).toBeGreaterThan(0.5);
  });

  it("needs the walk to cover ground", () => {
    const [a, b] = RIG3, lv = fromParams({ x: 0, y: 0, z: 1, yaw: 0, pitch: 0, roll: 0 });
    const line = (s: SimSensor) => Array.from({ length: 200 }, (_, k) => walkSample({ ...{ x: 0, y: 0, z: 0 }, ...(() => {
      const c = toSensor(s, [-1 + 0.01 * k, 0.5, 0.9]); return { x: c[0], y: c[1], z: c[2] }; })() }, k * 0.1, lv));
    expect(alignWalks(line(a), line(b))!.spread).toBeLessThan(0.05);
  });
});

describe("icp", () => {
  it("pulls a 20 cm / 5° wrong start back to within 1 cm / 0.1°", () => {
    const [a, b, c] = RIG3, target = mergeClouds([transformCloud(cloudOf(a), a.pose), transformCloud(cloudOf(c), c.pose)]);
    const wrong = compose(fromParams({ x: 0.15, y: -0.12, z: 0.05, yaw: 4, pitch: -1.5, roll: 2 }), b.pose);
    const r = icp(cloudOf(b), target, wrong);
    const e = poseError(r.pose, b.pose);
    expect(e.dist).toBeLessThan(0.01);
    expect(e.angle).toBeLessThan(0.1);
    expect(r.degenerate).toEqual([]);
    expect(r.median).toBeLessThan(0.005);
  });

  it("reports what a corridor leaves free and does not move along it", () => {
    const corridor: Room = { x0: -25, x1: 25, y0: -1.2, y1: 1.2, h: 2.6, boxes: [], people: () => [] };
    const a: SimSensor = { name: "a", pose: fromParams({ x: -2, y: -1, z: 1, yaw: 20, pitch: 0, roll: 0 }), phase: 0 };
    const b: SimSensor = { name: "b", pose: fromParams({ x: 2, y: 1, z: 1, yaw: 200, pitch: 0, roll: 0 }), phase: 0 };
    const start = compose(fromParams({ x: 0.3, y: 0.05, z: 0, yaw: 1, pitch: 0, roll: 0 }), b.pose);
    const r = icp(cloudOf(b, corridor), transformCloud(cloudOf(a, corridor), a.pose), start);
    expect(r.degenerate).toContain("x");      // and z, pitch, roll: their floors don't overlap
    expect(Math.abs(toParams(r.pose).yaw - toParams(b.pose).yaw)).toBeLessThan(0.1);   // fixed by the walls
    expect(Math.abs(r.pose.t[1] - b.pose.t[1])).toBeLessThan(0.01);                    // across the corridor
  });
});

describe("rig", () => {
  const check = (res: ReturnType<typeof calibrateRig>, dist: number, angle: number) => {
    for (const [k, s] of RIG3.entries()) {
      const e = poseError(res[k].pose, truth(s));
      expect(e.dist, `${s.name}: ${e.dist}`).toBeLessThan(dist);
      expect(e.angle, `${s.name}: ${e.angle}`).toBeLessThan(angle);
    }
  };

  it("calibrates three sensors from their empty scenes and one walk", () => {
    const res = calibrateRig(RIG3.map((s, k) => ({ name: s.name, cloud: cloudOf(s), walk: detections(s, [0, 0.06, 0.004][k], 40, k + 1) })));
    check(res, 0.01, 0.1);
    expect(Math.abs(res[1].timeOffset - 0.06)).toBeLessThan(0.015);    // a clock clearly off: used, and reported
    expect(res[1].problems).toEqual([expect.stringMatching(/clock is \d+ ms off a's/)]);
    expect(res[2].timeOffset).toBe(0);                                  // 4 ms: within the walk's uncertainty
    expect(res[0].problems.concat(res[2].problems)).toEqual([]);
    const entry = rigEntry(res[1]);
    expect(Object.keys(entry.pose as object)).toEqual(["x", "y", "z", "yaw", "pitch", "roll"]);
  });

  it("calibrates from what the pipeline itself detects, through the guided flow", { timeout: 60_000 }, () => {
    const cfg = defaultConfig(), procs = RIG3.map(() => new Processor(cfg));
    const cal = new Calibrator(RIG3.map(s => s.name), { walkSeconds: 30 });
    cal.start();
    let walkFrom = 0;
    for (let k = 0; k < 400 && !cal.progress().ready; k++) RIG3.forEach((s, j) => {
      const t = scanTime(s, k), p = procs[j];
      p.ingest(scanFrame({ ...s, noise: 0.01, seed: j + 1 }, ROOM, t, k), simMeta(s, t, k + 1));
      cal.scan(j, t, p, procs);
      if (cal.phase === "walk" && !walkFrom) walkFrom = t;
    });
    expect(walkFrom).toBeGreaterThan(1.9);                         // 2 s of empty scene first
    expect(walkFrom).toBeLessThan(3.1);                            // ... before the walker came in at 3 s
    expect(cal.progress().ready).toBe(true);
    const res = cal.solve(procs)!;
    expect(cal.phase).toBe("done");
    check(res, 0.03, 0.3);
  });
});
