// Calibrating a rig: floor → walk → ICP for every sensor (docs/multisensor.md). The world frame is the first
// sensor's levelled frame: z up, origin on the floor below it, x its forward direction.
import { DEG } from "../../core/math";
import { compose, fromParams, poseError, toParams, type Pose } from "../pose";
import { fitFloor, levelPose, type FloorFit } from "./floor";
import { jointIcp, type Cloud, type IcpOptions, type IcpResult } from "./icp";
import { alignWalks, walkSample, type WalkAlignment, type WalkSample } from "./walk";

/** what was collected for one sensor (all in its own frame, mount applied) */
export interface CalibInput {
  name: string;
  cloud: Cloud;                                           // empty scene, flat-surface points with normals
  walk: { t: number; x: number; y: number; z: number }[]; // the walker's detections: time, centroid
}

export interface SensorCalibration {
  name: string;
  pose: Pose;                    // sensor → world
  timeOffset: number;            // s, add to this sensor's scan times
  floor: FloorFit | null;
  walk: WalkAlignment | null;    // against `walkRef`
  walkRef: string;
  icp: IcpResult | null;
  problems: string[];            // what makes the result doubtful, in words for the panel
}

export interface CalibOptions {
  icp?: IcpOptions;
  /** the walk's time offset is used only beyond this (s): below it, it is within its own uncertainty (a time
   *  shift along a loop looks partly like a small turn), and the device clocks' sync is better than that */
  minTimeOffset?: number;
  /** ICP may move a sensor this far from the walk's estimate; beyond that the walk's is kept */
  maxIcpShift?: number; maxIcpTurn?: number;
}

/** levelled frame (yaw, x, y in 2D) as a pose */
const planar = (theta: number, tx: number, ty: number): Pose => fromParams({ x: tx, y: ty, z: 0, yaw: theta / DEG, pitch: 0, roll: 0 });

export function calibrateRig(inputs: CalibInput[], o: CalibOptions = {}): SensorCalibration[] {
  const res: SensorCalibration[] = inputs.map(s => ({ name: s.name, pose: fromParams({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 }),
                                                      timeOffset: 0, floor: null, walk: null, walkRef: "", icp: null, problems: [] }));
  // 1. floor: tilt and height
  const level = inputs.map((s, k) => {
    const f = fitFloor(s.cloud);
    res[k].floor = f;
    if (!f) res[k].problems.push("no floor seen: tilt and height unknown");
    return f ? levelPose(f) : fromParams({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 });
  });
  const walks: WalkSample[][] = inputs.map((s, k) => s.walk.map(d => walkSample(d, d.t, level[k])));

  // 2. walk: place the sensors one by one, each against the placed one it shares the most of the walk with
  const planarOf: (Pose | null)[] = inputs.map((_, k) => (k === 0 ? planar(0, 0, 0) : null));
  const dtOf = inputs.map(() => 0);
  for (let round = 1; round < inputs.length; round++) {
    let best: { k: number; ref: number; a: WalkAlignment } | null = null;
    for (let k = 0; k < inputs.length; k++) if (!planarOf[k])
      for (let r = 0; r < inputs.length; r++) if (planarOf[r]) {
        const a = alignWalks(walks[r], walks[k]);
        if (a && (!best || a.inliers > best.a.inliers)) best = { k, ref: r, a };
      }
    if (!best) break;
    const { k, ref, a } = best;
    planarOf[k] = compose(planarOf[ref]!, planar(a.theta, a.tx, a.ty));
    dtOf[k] = dtOf[ref] + (Math.abs(a.dt) > (o.minTimeOffset ?? 0.025) ? a.dt : 0);
    Object.assign(res[k], { walk: a, walkRef: inputs[ref].name, timeOffset: dtOf[k] });
    if (dtOf[k] !== dtOf[ref]) res[k].problems.push(`its clock is ${(a.dt * 1000).toFixed(0)} ms off ${inputs[ref].name}'s: check the clock sync`);
    if (a.spread < 0.5) res[k].problems.push(`the walk covered too little ground (${a.spread.toFixed(2)} m across): walk a wider loop`);
    if (a.rms > 0.15) res[k].problems.push(`tracks agree only to ${(a.rms * 100).toFixed(0)} cm`);
  }
  for (let k = 0; k < inputs.length; k++) {
    if (!planarOf[k]) res[k].problems.push("never saw the walker together with a placed sensor");
    res[k].pose = compose(planarOf[k] ?? planar(0, 0, 0), level[k]);
  }

  // 3. ICP on the static scene, all placed sensors at once (the first stays fixed: it is the world)
  const placed = inputs.flatMap((_, k) => (planarOf[k] ? [k] : []));
  const maxShift = o.maxIcpShift ?? 0.5, maxTurn = o.maxIcpTurn ?? 8;
  if (placed.length > 1) {
    const joint = jointIcp(placed.map(k => inputs[k].cloud), placed.map(k => res[k].pose), 0, o.icp);
    placed.forEach((k, m) => {
      if (k === 0) return;
      const r = joint[m], e = poseError(res[k].pose, r.pose);
      res[k].icp = r;
      if (isFinite(r.rms) && e.dist <= maxShift && e.angle <= maxTurn) res[k].pose = r.pose;
    });
  }
  for (let k = 1; k < inputs.length; k++) {
    const r = res[k].icp, e = poseError(compose(planarOf[k] ?? planar(0, 0, 0), level[k]), res[k].pose);
    if (!r || !isFinite(r.rms)) { if (planarOf[k]) res[k].problems.push("too little overlap with the other sensors to refine"); continue; }
    if (res[k].pose !== r.pose && (e.dist > maxShift || e.angle > maxTurn))
      res[k].problems.push("the static scene disagrees with the walk; kept the walk's estimate");
    if (r.overlap < 0.1) res[k].problems.push(`little overlap with the other sensors (${(r.overlap * 100).toFixed(0)} %)`);
    if (r.degenerate.length) res[k].problems.push(`the scene does not fix ${r.degenerate.join(", ")}: kept the walk's estimate there`);
  }
  return res;
}

/** a result as a rig entry (libs/wire/src/rig.ts), as the source server stores it */
export function rigEntry(c: SensorCalibration, when = new Date()): Record<string, unknown> {
  const p = toParams(c.pose), round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
  return {
    name: c.name,
    pose: { x: round(p.x, 4), y: round(p.y, 4), z: round(p.z, 4), yaw: round(p.yaw, 3), pitch: round(p.pitch, 3), roll: round(p.roll, 3) },
    time_offset_s: round(c.timeOffset, 4),
    calibrated: when.toISOString().slice(0, 19),
    ...(c.floor ? { floor: { pitch: round(c.floor.pitch, 3), roll: round(c.floor.roll, 3), height: round(c.floor.height, 4) } } : {}),
    quality: { floor_rms_mm: c.floor ? round(c.floor.rms * 1000, 1) : null, walk_rms_cm: c.walk ? round(c.walk.rms * 100, 1) : null,
               icp_median_mm: c.icp && isFinite(c.icp.median) ? round(c.icp.median * 1000, 1) : null,
               overlap: c.icp ? round(c.icp.overlap, 3) : null, degenerate: c.icp?.degenerate ?? [], problems: c.problems },
  };
}
