// Calibrating a rig: floor → walk → ICP for every sensor (docs/multisensor.md). Every sensor is mounted level, so a
// pose is x, y, z and yaw. The world is the floor below the main sensor (`origin`): z up, x its forward direction.
//   1. floor: each sensor's height above it, from its own empty scene
//   2. walk: every pair that saw the walker together gives where one stands in the other's frame, its clock offset
//      and the difference in height; all pairs are solved together (graph.ts)
//   3. heights: the floors, the heights given by hand, the walker's feet and the walk's differences, together
//   4. ICP on the static scene, all sensors at once, accepted per direction while it stays near the walk's result
import { DEG } from "../../core/math";
import { fromParams, toParams, type Pose } from "../pose";
import { fitFloor, type FloorFit } from "./floor";
import { solveLinear, solvePlanar, type Planar } from "./graph";
import { jointIcp, type Cloud, type IcpOptions, type IcpResult } from "./icp";
import { alignWalks, walkSample, type WalkAlignment } from "./walk";

/** one detection of the walker: time, centroid, and its lowest point when the detector saw all of it (the feet) */
export interface WalkDetection { t: number; x: number; y: number; z: number; z0?: number }

/** what was collected for one sensor (all in its own frame, mount applied) */
export interface CalibInput {
  name: string;
  cloud: Cloud;                  // empty scene, flat-surface points with normals
  walk: WalkDetection[];
}

export type HeightSource = "floor" | "given" | "walk" | "feet" | "unknown";

export interface SensorCalibration {
  name: string;
  pose: Pose;                    // sensor → world
  timeOffset: number;            // s, add to this sensor's scan times
  floor: FloorFit | null;
  height: HeightSource;          // where its z came from
  walk: WalkAlignment | null;    // its best pair, against `walkRef`
  walkRef: string;
  icp: IcpResult | null;
  problems: string[];            // what makes the result doubtful, in words for the panel
}

export interface CalibOptions {
  icp?: IcpOptions;
  origin?: number;               // the main sensor: its floor point is the world's origin (default: the first)
  heights?: (number | null)[];   // heights above the floor measured by hand, per sensor (null: not known)
  /** the walk's time offset is used only beyond this (s): below it, it is within its own uncertainty (a time
   *  shift along a loop looks partly like a small turn), and the device clocks' sync is better than that */
  minTimeOffset?: number;
  /** ICP may move a sensor this far from the walk's estimate, per direction; beyond that the walk's is kept */
  maxIcpShift?: number; maxIcpTurn?: number; maxIcpLift?: number;
}

const SIGMA = { given: 0.005, floor: 0.01, feet: 0.05, walk: 0.1 };   // m: how far each source of a height is trusted
const at = (p: Planar, z: number): Pose => fromParams({ x: p[1], y: p[2], z, yaw: p[0] / DEG });

function percentile(v: number[], f: number): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
}

export function calibrateRig(inputs: CalibInput[], o: CalibOptions = {}): SensorCalibration[] {
  const S = inputs.length, main = o.origin ?? 0, name = (k: number) => inputs[k].name;
  const res: SensorCalibration[] = inputs.map(s => ({ name: s.name, pose: fromParams({ x: 0, y: 0, z: 0, yaw: 0 }), timeOffset: 0, floor: null,
                                                      height: "unknown", walk: null, walkRef: "", icp: null, problems: [] }));
  // 1. floor
  inputs.forEach((s, k) => {
    const f = res[k].floor = fitFloor(s.cloud);
    if (f && f.tilt > 1) res[k].problems.push(`its floor leans ${f.tilt.toFixed(1)}°: is the sensor level?`);
  });

  // 2. walk: every pair, then all at once
  const walks = inputs.map(s => s.walk.map(d => walkSample(d, d.t)));
  const edges: { i: number; j: number; a: WalkAlignment }[] = [];
  for (let i = 0; i < S; i++) for (let j = i + 1; j < S; j++) {
    const a = alignWalks(walks[i], walks[j]);
    if (a) edges.push({ i, j, a });
  }
  const weight = (a: WalkAlignment) => a.inliers / Math.max(a.rms, 0.03) ** 2;
  const planar = solvePlanar(S, main, edges.map(({ i, j, a }) => ({ i, j, theta: a.theta, tx: a.tx, ty: a.ty, w: weight(a) })));
  const kept = edges.filter((_, e) => planar.used[e]);
  const clocks = solveLinear(S, [{ i: main, v: 0, w: 1e9 }], kept.map(({ i, j, a }) => ({ i, j, d: a.dt, w: a.inliers })));
  for (let k = 0; k < S; k++) {
    if (k === main) continue;
    if (!planar.poses[k]) { res[k].problems.push("never saw the walker together with a placed sensor"); continue; }
    const best = kept.filter(e => e.i === k || e.j === k).sort((x, y) => y.a.inliers - x.a.inliers)[0];
    if (best) {
      const a = best.a;
      Object.assign(res[k], { walk: a, walkRef: name(best.i === k ? best.j : best.i) });
      if (a.spread < 0.5) res[k].problems.push(`the walk covered too little ground (${a.spread.toFixed(2)} m across): walk a wider loop`);
      if (a.rms > 0.15) res[k].problems.push(`tracks agree only to ${(a.rms * 100).toFixed(0)} cm`);
    }
    const dt = clocks[k] ?? 0;
    if (Math.abs(dt) > (o.minTimeOffset ?? 0.025)) {
      res[k].timeOffset = dt;
      res[k].problems.push(`its clock is ${(dt * 1000).toFixed(0)} ms off ${name(main)}'s: check the clock sync`);
    }
  }
  edges.forEach((e, x) => {
    if (!planar.used[x]) res[e.j].problems.push(`its walk with ${name(e.i)} disagrees with the rest (${(planar.error[x] * 100).toFixed(0)} cm): left out`);
  });

  // 3. heights
  const readings: { i: number; v: number; w: number }[] = [];
  const source: HeightSource[] = inputs.map(() => "unknown");
  inputs.forEach((s, k) => {
    const given = o.heights?.[k], f = res[k].floor, feet = s.walk.flatMap(d => (d.z0 !== undefined ? [d.z0] : []));
    if (given !== null && given !== undefined) { readings.push({ i: k, v: given, w: SIGMA.given ** -2 }); source[k] = "given"; }
    else if (f) { readings.push({ i: k, v: f.height, w: SIGMA.floor ** -2 }); source[k] = "floor"; }
    else if (feet.length >= 50) { readings.push({ i: k, v: -percentile(feet, 0.05), w: SIGMA.feet ** -2 }); source[k] = "feet"; }
  });
  const heights = solveLinear(S, readings, kept.map(({ i, j, a }) => ({ i, j, d: a.dz, w: Math.max(SIGMA.walk, 1.5 * a.dzMad) ** -2 })));
  for (let k = 0; k < S; k++) {
    res[k].height = heights[k] === null ? "unknown" : source[k] === "unknown" ? "walk" : source[k];
    if (res[k].height === "unknown") res[k].problems.push("height unknown: it sees no floor, and no sensor that does saw the walker with it; enter its height");
    else if (res[k].height === "walk") res[k].problems.push("no floor seen: height from the walker, to about 10 cm");
    else if (res[k].height === "feet") res[k].problems.push("no floor seen: height from the walker's feet, to about 5 cm");
    res[k].pose = at(planar.poses[k] ?? [0, 0, 0], heights[k] ?? 0);
  }

  // 4. ICP on the static scene, all placed sensors at once (the main one stays fixed: it is the world)
  icpStep(res, inputs.map(s => s.cloud), inputs.flatMap((_, k) => (planar.poses[k] ? [k] : [])), main, o);
  return res;
}

/** ICP from the poses in `res` (in place), accepted per direction while it stays within the limits of them */
function icpStep(res: SensorCalibration[], clouds: Cloud[], placed: number[], main: number, o: CalibOptions): void {
  const maxShift = o.maxIcpShift ?? 0.5, maxTurn = o.maxIcpTurn ?? 8, maxLift = o.maxIcpLift ?? 0.15;
  if (placed.length < 2) return;
  const joint = jointIcp(placed.map(k => clouds[k]), placed.map(k => res[k].pose), placed.indexOf(main), o.icp);
  placed.forEach((k, m) => {
    if (k === main) return;
    const r = res[k].icp = joint[m];
    if (!isFinite(r.rms)) { res[k].problems.push("too little overlap with the other sensors to refine"); return; }
    const was = toParams(res[k].pose), now = toParams(r.pose), turn = Math.abs(((now.yaw - was.yaw + 540) % 360) - 180);
    const planarOk = Math.hypot(now.x - was.x, now.y - was.y) <= maxShift && turn <= maxTurn;
    const liftOk = Math.abs(now.z - was.z) <= maxLift;
    res[k].pose = fromParams({ ...(planarOk ? now : was), z: liftOk ? now.z : was.z });
    if (!planarOk) res[k].problems.push("the static scene disagrees with the walk; kept the walk's position and turn");
    if (!liftOk) res[k].problems.push(`the static scene puts it ${((now.z - was.z) * 100).toFixed(0)} cm higher than the ${res[k].height}; kept that height`);
    if (r.overlap < 0.1) res[k].problems.push(`little overlap with the other sensors (${(r.overlap * 100).toFixed(0)} %)`);
    if (r.degenerate.length) res[k].problems.push(`the scene does not fix ${r.degenerate.join(", ")}: kept the walk's estimate there`);
  });
}

/** ICP again from poses set by hand (`prev`, e.g. a calibration nudged on the page): for when the walk's estimate was
 *  off and the scene alone can finish the job. It may move a sensor as far along the floor as the solve's ICP may (its
 *  first match distance is 0.5 m anyway), but its height only by 5 cm: heights come from the floor or the user. */
export function refineRig(clouds: Cloud[], prev: SensorCalibration[], main: number, o: CalibOptions = {}): SensorCalibration[] {
  const res = prev.map(r => ({ ...r, problems: r.problems.filter(p => !/static scene|overlap|does not fix/.test(p)), icp: null }));
  icpStep(res, clouds, res.map((_, k) => k), main, { maxIcpLift: 0.05, ...o });
  return res;
}

/** a result as a rig entry (libs/wire/src/rig.ts), as the source server stores it */
export function rigEntry(c: SensorCalibration, when = new Date()): Record<string, unknown> {
  const p = toParams(c.pose), round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d + 0;
  return {
    name: c.name,
    pose: { x: round(p.x, 4), y: round(p.y, 4), z: round(p.z, 4), yaw: round(p.yaw, 3) },
    time_offset_s: round(c.timeOffset, 4),
    calibrated: when.toISOString().slice(0, 19),
    quality: { height: c.height, floor_rms_mm: c.floor ? round(c.floor.rms * 1000, 1) : null, walk_rms_cm: c.walk ? round(c.walk.rms * 100, 1) : null,
               icp_median_mm: c.icp && isFinite(c.icp.median) ? round(c.icp.median * 1000, 1) : null,
               overlap: c.icp ? round(c.icp.overlap, 3) : null, degenerate: c.icp?.degenerate ?? [], problems: c.problems },
  };
}
