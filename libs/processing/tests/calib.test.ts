// Calibration on the simulated rig (sim/rig.ts), whose true poses are known.
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/config";
import { DEG } from "../src/core/math";
import { fitFloor } from "../src/fusion/calib/floor";
import { solveLinear, solvePlanar } from "../src/fusion/calib/graph";
import { icp, mergeClouds, transformCloud } from "../src/fusion/calib/icp";
import { Calibrator } from "../src/fusion/calib/calibrator";
import { calibrateRig, rigEntry } from "../src/fusion/calib/rig";
import { alignWalks, walkSample } from "../src/fusion/calib/walk";
import { kabsch2d, solve, symEigen } from "../src/fusion/linalg";
import { compose, fromParams, invert, poseError, tilt, toParams } from "../src/fusion/pose";
import { Processor } from "../src/pipeline/processor";
import { cloudOf, detections, truth, withoutFloor } from "../sim/calib";
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
  it("gives every sensor's height within 1 cm, and no lean", () => {
    for (const s of RIG3) {
      const f = fitFloor(cloudOf(s))!;
      expect(f, s.name).not.toBeNull();
      expect(Math.abs(f.height - s.pose.t[2]), s.name).toBeLessThan(0.01);
      expect(f.tilt, s.name).toBeLessThan(0.3);
    }
  });

  it("finds none without a floor in view", () => {
    expect(fitFloor(withoutFloor(cloudOf(RIG3[0])))).toBeNull();
  });

  it("takes the floor, not a table top above it", () => {
    const room: Room = { ...ROOM, people: () => [], boxes: [...ROOM.boxes, { x0: -2.6, x1: -1.0, y0: -2.2, y1: -0.8, z0: 0, z1: 0.72 }] };
    expect(Math.abs(fitFloor(cloudOf(RIG3[0], room))!.height - RIG3[0].pose.t[2])).toBeLessThan(0.01);
  });
});

describe("walk alignment", () => {
  it("finds the clock offset, position, yaw and height of one sensor relative to another", () => {
    const [a, b] = RIG3;
    const wa = detections(a).map(d => walkSample(d, d.t)), wb = detections(b, 0.137, 40, 2).map(d => walkSample(d, d.t));
    const al = alignWalks(wa, wb)!;
    expect(al.dt).toBeCloseTo(0.137, 2);                        // within 5 ms
    const rel = compose(invert(a.pose), b.pose), est = fromParams({ x: al.tx, y: al.ty, z: al.dz, yaw: al.theta / DEG });
    const e = poseError(est, rel);
    expect(e.dist).toBeLessThan(0.03);
    expect(e.angle).toBeLessThan(0.3);
    expect(al.spread).toBeGreaterThan(0.5);
  });

  it("needs the walk to cover ground", () => {
    const [a, b] = RIG3;
    const line = (s: SimSensor) => Array.from({ length: 200 }, (_, k) => {
      const c = toSensor(s, [-1 + 0.01 * k, 0.5, 0.9]); return walkSample({ x: c[0], y: c[1], z: c[2] }, k * 0.1);
    });
    expect(alignWalks(line(a), line(b))!.spread).toBeLessThan(0.05);
  });
});

describe("pose graph", () => {
  const place = ([th, x, y]: number[], [th2, x2, y2]: number[]) => {        // j in i's frame
    const c = Math.cos(th), s = Math.sin(th), dx = x2 - x, dy = y2 - y;
    return { theta: th2 - th, tx: c * dx + s * dy, ty: -s * dx + c * dy };
  };
  const truthP = [[0, 0, 0], [2.4, 4, 0.3], [-1.6, 0.5, 5], [0.7, 4.5, 5.2]];

  it("solves all sensors at once, drops an edge that disagrees, and spreads the error instead of chaining it", () => {
    const noisy = (i: number, j: number, n: number[]) => { const p = place(truthP[i], truthP[j]); return { i, j, theta: p.theta + n[0], tx: p.tx + n[1], ty: p.ty + n[2], w: 1 }; };
    const edges = [noisy(0, 1, [0.004, 0.02, -0.01]), noisy(1, 3, [-0.003, 0.01, 0.02]), noisy(0, 2, [0.002, -0.02, 0.01]),
                   noisy(2, 3, [0.003, 0.01, -0.02]), noisy(0, 3, [0.3, 1, -0.6])];           // the last one is wrong
    const r = solvePlanar(4, 0, edges);
    expect(r.used).toEqual([true, true, true, true, false]);
    r.poses.forEach((p, k) => {
      expect(Math.hypot(p![1] - truthP[k][1], p![2] - truthP[k][2]), String(k)).toBeLessThan(0.05);
      expect(Math.abs(p![0] - truthP[k][0])).toBeLessThan(0.01);
    });
  });

  it("leaves out sensors no edge reaches, and solves values from differences", () => {
    expect(solvePlanar(3, 0, [{ i: 0, j: 1, ...place(truthP[0], truthP[1]), w: 1 }]).poses[2]).toBeNull();
    const z = solveLinear(4, [{ i: 0, v: 1, w: 100 }, { i: 2, v: 2.02, w: 100 }], [{ i: 0, j: 1, d: 0.5, w: 1 }, { i: 1, j: 2, d: 0.5, w: 1 }]);
    expect(z[0]).toBeCloseTo(1, 3);
    expect(z[1]).toBeCloseTo(1.51, 2);
    expect(z[3]).toBeNull();
  });
});

describe("icp", () => {
  it("pulls a 20 cm / 5° wrong start back to within 1 cm / 0.1°", () => {
    const [a, b, c] = RIG3, target = mergeClouds([transformCloud(cloudOf(a), a.pose), transformCloud(cloudOf(c), c.pose)]);
    const wrong = compose(fromParams({ x: 0.15, y: -0.12, z: 0.05, yaw: 4 }), b.pose);
    const r = icp(cloudOf(b), target, wrong);
    const e = poseError(r.pose, b.pose);
    expect(e.dist).toBeLessThan(0.01);
    expect(e.angle).toBeLessThan(0.1);
    expect(r.degenerate).toEqual([]);
    expect(r.median).toBeLessThan(0.005);
    expect(tilt(r.pose)).toBe(0);                                         // only turns about z
  });

  it("reports what a corridor leaves free and does not move along it", () => {
    const corridor: Room = { x0: -25, x1: 25, y0: -1.2, y1: 1.2, h: 2.6, boxes: [], people: () => [] };
    const a: SimSensor = { name: "a", pose: fromParams({ x: -2, y: -1, z: 1, yaw: 20 }), phase: 0 };
    const b: SimSensor = { name: "b", pose: fromParams({ x: 2, y: 1, z: 1, yaw: 200 }), phase: 0 };
    const start = compose(fromParams({ x: 0.3, y: 0.05, z: 0, yaw: 1 }), b.pose);
    const r = icp(cloudOf(b, corridor), transformCloud(cloudOf(a, corridor), a.pose), start);
    expect(r.degenerate).toContain("x");      // and z: their floors don't overlap
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
    expect(Object.keys(entry.pose as object)).toEqual(["x", "y", "z", "yaw"]);
    expect(res.map(r => r.height)).toEqual(["floor", "floor", "floor"]);
  });

  it("gives a sensor that sees no floor its height from the walk, and one the user measured theirs", () => {
    const inputs = RIG3.map((s, k) => ({ name: s.name, cloud: k === 2 ? withoutFloor(cloudOf(s)) : cloudOf(s), walk: detections(s, 0, 40, k + 1) }));
    const noFeet = inputs.map(x => ({ ...x, walk: x.walk.map(({ z0: _, ...d }) => d) }));
    const fromWalk = calibrateRig(noFeet, { icp: { dists: [] } });        // no ICP: the shared floor would fix it anyway
    expect(fromWalk[2].height).toBe("walk");
    expect(Math.abs(fromWalk[2].pose.t[2] - RIG3[2].pose.t[2])).toBeLessThan(0.05);
    const fromFeet = calibrateRig(inputs.map((x, k) => (k === 2 ? x : { ...x, cloud: withoutFloor(x.cloud) })), { icp: { dists: [] } });
    expect(fromFeet.map(r => r.height)).toEqual(["feet", "walk", "feet"]);     // b, 1.6 m up, never saw the walker's feet
    fromFeet.forEach((r, k) => expect(Math.abs(r.pose.t[2] - RIG3[k].pose.t[2]), r.name).toBeLessThan(0.05));
    const given = calibrateRig(inputs, { heights: [null, null, 0.75] });
    expect(given[2].height).toBe("given");
    check(given, 0.01, 0.1);
  });

  it("puts the world on the floor below the main sensor", () => {
    const res = calibrateRig(RIG3.map((s, k) => ({ name: s.name, cloud: cloudOf(s), walk: detections(s, 0, 40, k + 1) })), { origin: 1 });
    for (const [k, s] of RIG3.entries()) {
      const e = poseError(res[k].pose, truth(s, RIG3[1]));
      expect(e.dist, s.name).toBeLessThan(0.01);
    }
    expect(toParams(res[1].pose)).toEqual({ x: expect.closeTo(0, 9), y: expect.closeTo(0, 9), z: expect.closeTo(1.6, 2), yaw: expect.closeTo(0, 9) });
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
