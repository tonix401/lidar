// Calibration step 1: the floor → each sensor's height. Every sensor is mounted level, so the floor is the plane
// z = −height in its own frame, and finding it is one number: the height of the lowest horizontal surface. The
// lowest layers look down at up to −13°, so a sensor ~1 m up sees the floor from about 4 m out. Candidates are the
// empty-scene points below the sensor whose own normals are near-vertical (so the foot of a wall, which the lowest
// layer may hit a few cm above the floor, never counts); a histogram of their heights has a peak for every
// horizontal surface (floor, table tops, the desk), and the floor is the lowest peak that several layers see
// (one layer's beams lie on a cone, and part of a cone passes for a surface) with nothing clearly below it.
// The floor's tilt in the sensor frame is still measured, only to warn when a sensor is not level after all.
import { DEG, smallestEigenvector } from "../../core/math";
import type { Cloud } from "./icp";

export interface FloorFit {
  height: number;                // sensor origin above the floor (m)
  inliers: number; rms: number;  // points on the floor, their spread in height (m)
  tilt: number;                  // degrees: how far the floor leans in the sensor's frame (≈ 0 when it is level)
}

export interface FloorOptions {
  tol?: number;             // half-width of the floor's band (m)
  minInliers?: number;
  minLayers?: number;       // layers with at least 10 inliers each
  maxBelow?: number;        // share of the points allowed more than 0.1 m below it (noise, multipath)
  maxNormal?: number;       // degrees: how far a candidate's normal may lean from vertical
}

/** `c`: the empty scene in the sensor frame (mount applied), see gridCloud */
export function fitFloor(c: Cloud, o: FloorOptions = {}): FloorFit | null {
  const tol = o.tol ?? 0.03, minLayers = o.minLayers ?? 3, maxBelow = o.maxBelow ?? 0.01, minInliers = o.minInliers ?? 50;
  const up = Math.cos((o.maxNormal ?? 15) * DEG), BIN = 0.01;
  const cand: number[] = [];
  for (let i = 0; i < c.count; i++) if (c.p[3 * i + 2] < -0.2 && c.n[3 * i + 2] > up) cand.push(i);
  if (cand.length < minInliers) return null;
  const z = (i: number) => c.p[3 * i + 2];
  let lo = Infinity;
  for (const i of cand) lo = Math.min(lo, z(i));
  const bins = new Array<number>(Math.ceil(-lo / BIN) + 2).fill(0);
  for (const i of cand) bins[Math.floor((z(i) - lo) / BIN)]++;
  const w = Math.round(tol / BIN), band = (b: number) => { let n = 0; for (let k = b - w; k <= b + w; k++) n += bins[k] ?? 0; return n; };
  for (let b = 0; b < bins.length; b++) {                                     // lowest first
    const n = band(b);
    if (n < minInliers || band(b - 1) > n || band(b + 1) > n) continue;        // too small, or not a peak
    const centre = lo + (b + 0.5) * BIN, inl = cand.filter(i => Math.abs(z(i) - centre) <= tol);
    const perLayer = new Map<number, number>();
    for (const i of inl) perLayer.set(c.layer[i], (perLayer.get(c.layer[i]) ?? 0) + 1);
    if ([...perLayer.values()].filter(k => k >= 10).length < minLayers) continue;
    let below = 0;
    for (let i = 0; i < c.count; i++) if (c.p[3 * i + 2] < centre - 0.1) below++;
    if (below > maxBelow * c.count) continue;
    const hs = inl.map(z).sort((a, b) => a - b), med = hs[hs.length >> 1];
    const mean = hs.reduce((a, v) => a + v, 0) / hs.length, rms = Math.sqrt(hs.reduce((a, v) => a + (v - mean) ** 2, 0) / hs.length);
    return { height: -med, inliers: inl.length, rms, tilt: planeTilt(c, inl) };
  }
  return null;
}

/** the angle between the inliers' best-fit plane and level (degrees) */
function planeTilt(c: Cloud, inl: number[]): number {
  let mx = 0, my = 0, mz = 0;
  for (const i of inl) { mx += c.p[3 * i]; my += c.p[3 * i + 1]; mz += c.p[3 * i + 2]; }
  mx /= inl.length; my /= inl.length; mz /= inl.length;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const i of inl) {
    const x = c.p[3 * i] - mx, y = c.p[3 * i + 1] - my, z = c.p[3 * i + 2] - mz;
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  const n = [0, 0, 0];
  if (smallestEigenvector(xx, xy, xz, yy, yz, zz, n) < 0) return 0;
  return Math.acos(Math.min(1, Math.abs(n[2]))) / DEG;
}
