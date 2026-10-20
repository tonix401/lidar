// Calibration step 1: the floor → each sensor's tilt (pitch, roll) and height. The lowest layers look
// down at up to −13°, so a sensor ~1 m up sees the floor from about 4 m out. RANSAC finds the largest
// near-horizontal plane below the sensor among its empty-scene points whose own normals are near-vertical
// (so the foot of a wall, which the lowest layer may hit a few cm above the floor, never counts); a PCA fit
// over its inliers refines it. The floor normal in the sensor frame is the world's "up" as the sensor sees
// it, which is the tilt. A plane only counts as the floor if several layers see it (one layer's beams lie
// on a cone, and part of a cone passes for a tilted plane) and nothing lies clearly below it.
import { DEG, smallestEigenvector } from "../../core/math";
import { fromParams, type Pose } from "../pose";
import type { Cloud } from "./icp";

export interface FloorFit {
  normal: number[];     // unit, sensor frame, pointing up (towards the sensor)
  height: number;       // sensor origin above the floor (m)
  pitch: number; roll: number;                 // degrees: the levelling pose's
  inliers: number; rms: number;                // points on the floor, their distance from it (m)
}

export interface FloorOptions {
  tol?: number;             // inlier distance (m)
  maxTilt?: number;         // degrees: how far from level a sensor may stand
  iterations?: number; minInliers?: number; seed?: number;
  minLayers?: number;       // layers with at least 10 inliers each
  maxBelow?: number;        // share of the points allowed more than 0.1 m below it (noise, multipath)
}

/** `c`: the empty scene in the sensor frame (mount applied), see gridCloud */
export function fitFloor(c: Cloud, o: FloorOptions = {}): FloorFit | null {
  const tol = o.tol ?? 0.02, maxTilt = o.maxTilt ?? 10, minUp = Math.cos(maxTilt * DEG), iters = o.iterations ?? 300;
  const minLayers = o.minLayers ?? 3, maxBelow = o.maxBelow ?? 0.01, minInliers = o.minInliers ?? 50;
  const P = (i: number, k: number) => c.p[3 * i + k], vertical = Math.cos((maxTilt + 10) * DEG);
  const cand: number[] = [];
  for (let i = 0; i < c.count; i++) if (P(i, 2) < -0.2 && c.n[3 * i + 2] > vertical) cand.push(i);
  if (cand.length < minInliers) return null;
  let seed = o.seed ?? 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const dist = (nn: number[], d: number, i: number) => nn[0] * P(i, 0) + nn[1] * P(i, 1) + nn[2] * P(i, 2) + d;
  let best: { n: number[]; d: number; count: number } | null = null;
  for (let it = 0; it < iters; it++) {
    const [a, b, e] = [0, 1, 2].map(() => cand[(rnd() * cand.length) | 0]);
    const u = [P(b, 0) - P(a, 0), P(b, 1) - P(a, 1), P(b, 2) - P(a, 2)], v = [P(e, 0) - P(a, 0), P(e, 1) - P(a, 1), P(e, 2) - P(a, 2)];
    let nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(nn[0], nn[1], nn[2]);
    if (len < 1e-9) continue;
    nn = nn.map(x => x / len);
    if (nn[2] < 0) nn = nn.map(x => -x);
    if (nn[2] < minUp) continue;                                             // not near-horizontal
    const d = -(nn[0] * P(a, 0) + nn[1] * P(a, 1) + nn[2] * P(a, 2));        // n·p + d = 0
    if (d <= 0) continue;                                                    // must lie below the sensor
    let count = 0;
    const perLayer = new Map<number, number>();
    for (const i of cand) if (Math.abs(dist(nn, d, i)) < tol) { count++; perLayer.set(c.layer[i], (perLayer.get(c.layer[i]) ?? 0) + 1); }
    if (best && count <= best.count) continue;
    if ([...perLayer.values()].filter(k => k >= 10).length < minLayers) continue;
    let below = 0;
    for (let i = 0; i < c.count; i++) if (dist(nn, d, i) < -0.1) below++;
    if (below > maxBelow * c.count) continue;
    best = { n: nn, d, count };
  }
  if (!best || best.count < minInliers) return null;
  let normal = best.n, d = best.d, inl: number[] = [];
  for (let round = 0; round < 3; round++) {                                  // PCA refit over the inliers
    inl = cand.filter(i => Math.abs(dist(normal, d, i)) < tol);
    let mx = 0, my = 0, mz = 0;
    for (const i of inl) { mx += P(i, 0); my += P(i, 1); mz += P(i, 2); }
    mx /= inl.length; my /= inl.length; mz /= inl.length;
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (const i of inl) {
      const x = P(i, 0) - mx, y = P(i, 1) - my, z = P(i, 2) - mz;
      xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
    }
    const out = [0, 0, 0];
    if (smallestEigenvector(xx, xy, xz, yy, yz, zz, out) < 0) break;
    normal = out[2] < 0 ? out.map(x => -x) : out;
    d = -(normal[0] * mx + normal[1] * my + normal[2] * mz);
  }
  let ss = 0;
  for (const i of inl) ss += dist(normal, d, i) ** 2;
  // the levelling rotation R = Ry(pitch)·Rx(roll) maps the normal onto +z: its last row is the normal
  return { normal, height: d, pitch: Math.asin(-normal[0]) / DEG, roll: Math.atan2(normal[1], normal[2]) / DEG,
           inliers: inl.length, rms: Math.sqrt(ss / inl.length) };
}

/** sensor frame → its levelled frame (origin on the floor below the sensor, z up, x its forward direction) */
export const levelPose = (f: FloorFit): Pose => fromParams({ x: 0, y: 0, z: f.height, yaw: 0, pitch: f.pitch, roll: f.roll });
