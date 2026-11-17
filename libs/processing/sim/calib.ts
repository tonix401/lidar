// Inputs for calibration and fusion tests, made from the simulated rig (rig.ts) with known truth.
import { DEG } from "../src/core/math";
import { gridCloud, type Cloud } from "../src/fusion/calib/icp";
import type { CalibInput } from "../src/fusion/calib/rig";
import { compose, fromParams, invert, toParams, type Pose } from "../src/fusion/pose";
import { castScan, RIG3, ROOM, scanTime, simGeometry, toSensor, walker, type Room, type SimSensor } from "./rig";
import { elevations, gauss, rng } from "./scene";

export const EMPTY: Room = { ...ROOM, people: () => [] };

/** unit rays of a simulated sensor (sensor frame, upright), as the pipeline computes them */
export function rays(s: SimSensor) {
  const { L, B, az0, step } = simGeometry(s), el = elevations(L), N = L * B;
  const rx = new Float32Array(N), ry = new Float32Array(N), rz = new Float32Array(N);
  for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
    const az = (az0 + b * step) * DEG, e = el[l] * DEG, i = l * B + b;
    rx[i] = Math.cos(az) * Math.cos(e); ry[i] = Math.sin(az) * Math.cos(e); rz[i] = Math.sin(e);
  }
  return { rx, ry, rz, L, B };
}

export function cloudOf(s: SimSensor, room = EMPTY, noise = 0.003) {
  const { rx, ry, rz, L, B } = rays(s), d = castScan({ ...s, noise }, room, 0);
  return gridCloud(d, rx, ry, rz, L, B);
}

/** the true pose of `s` in the calibration's world: the floor below the first sensor */
export function truth(s: SimSensor, first = RIG3[0]): Pose {
  return compose(invert(fromParams({ ...toParams(first.pose), z: 0 })), s.pose);
}

/** the empty scene without the floor: what a sensor whose floor is out of view (or cluttered) sees */
export function withoutFloor(c: Cloud): Cloud {
  const keep = Array.from({ length: c.count }, (_, i) => i).filter(i => c.n[3 * i + 2] < 0.9);
  return { p: Float32Array.from(keep.flatMap(i => [c.p[3 * i], c.p[3 * i + 1], c.p[3 * i + 2]])),
           n: Float32Array.from(keep.flatMap(i => [c.n[3 * i], c.n[3 * i + 1], c.n[3 * i + 2]])),
           layer: Uint8Array.from(keep.map(i => c.layer[i])), count: keep.length };
}

/** the walker as each sensor's detector would report it: the visible side's centroid (0.1 m towards the
 *  sensor), 2 cm noise, at its scan times, on its clock (`clockErr` s behind the true time); its lowest point (the
 *  feet) only once they are far enough away for the lowest layer to pass below them */
export function detections(s: SimSensor, clockErr = 0, seconds = 40, seed = 1) {
  const r = rng(seed), out: CalibInput["walk"] = [], low = Math.tan(-elevations(simGeometry(s).L)[0] * DEG);
  for (let k = 0; k < seconds * 10; k++) {
    const t = scanTime(s, k), [p] = walker()(t);
    if (!p) continue;
    const toS = [s.pose.t[0] - p.x, s.pose.t[1] - p.y], h = Math.hypot(toS[0], toS[1]);
    const c = toSensor(s, [p.x + 0.1 * toS[0] / h + 0.02 * gauss(r), p.y + 0.1 * toS[1] / h + 0.02 * gauss(r), 0.9]);
    const feet = h * low >= s.pose.t[2] ? { z0: 0.01 * gauss(r) - s.pose.t[2] } : {};   // nearer, the person is clipped
    if (c[0] > 0 && Math.abs(Math.atan2(c[1], c[0])) < 60 * DEG) out.push({ t: t - clockErr, x: c[0], y: c[1], z: c[2], ...feet });
  }
  return out;
}
