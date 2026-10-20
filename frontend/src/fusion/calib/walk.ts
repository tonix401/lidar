// Calibration step 2: one person walking → time offset, x, y and yaw of a sensor relative to another.
// Both sensors (levelled by the floor fit) track the same person, so their tracks are the same curve, only
// rotated and shifted (and shifted in time, if the clocks still differ). For each candidate time offset,
// pair the samples by time, fit the 2D rigid transform (Kabsch) and keep the offset with the smallest
// trimmed residual; then RANSAC over the pairs drops moments where one sensor's track was wrong (an arm
// split off, the person half hidden).
import type { Detection } from "../../objects/segment";
import { kabsch2d } from "../linalg";
import { apply, type Pose } from "../pose";

export interface WalkSample { t: number; x: number; y: number }      // levelled frame of its sensor (m)

/** a person's centroid is the middle of the part the sensor sees, about 2r/π ≈ 0.1 m in front of the body's
 *  axis; sensors on different sides see different halves, so each sample is pushed back by that much */
export const VISIBLE_SIDE_OFFSET = 0.1;

export function walkSample(det: Pick<Detection, "x" | "y" | "z">, t: number, level: Pose): WalkSample {
  const p = apply(level, [det.x, det.y, det.z]), h = Math.hypot(p[0], p[1]) || 1;
  return { t, x: p[0] * (1 + VISIBLE_SIDE_OFFSET / h), y: p[1] * (1 + VISIBLE_SIDE_OFFSET / h) };
}

export interface WalkAlignment {
  theta: number; tx: number; ty: number;     // levelled frame of `other` → levelled frame of `ref` (rad, m)
  dt: number;                                // add to `other`'s times to get `ref`'s (s)
  rms: number;                               // over the inliers (m)
  pairs: number; inliers: number;
  spread: number;                            // smaller standard deviation of the walk (m): its coverage
}

export interface WalkOptions { maxLag?: number; minPairs?: number; inlierTol?: number; maxGap?: number }

/** ref's position at time t (linear between samples less than maxGap apart), or null */
function at(ref: WalkSample[], t: number, maxGap: number): number[] | null {
  let lo = 0, hi = ref.length - 1;
  if (!ref.length || t < ref[0].t || t > ref[hi].t) return null;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ref[m].t <= t) lo = m; else hi = m; }
  const a = ref[lo], b = ref[hi];
  if (b.t - a.t > maxGap) return null;
  const w = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return [a.x + w * (b.x - a.x), a.y + w * (b.y - a.y)];
}

function pairsAt(ref: WalkSample[], other: WalkSample[], dt: number, maxGap: number): [number[], number[]][] {
  const out: [number[], number[]][] = [];
  for (const s of other) { const r = at(ref, s.t + dt, maxGap); if (r) out.push([[s.x, s.y], r]); }
  return out;
}

const residuals = (pairs: [number[], number[]][], { theta, tx, ty }: { theta: number; tx: number; ty: number }) => {
  const c = Math.cos(theta), s = Math.sin(theta);
  return pairs.map(([f, g]) => Math.hypot(c * f[0] - s * f[1] + tx - g[0], s * f[0] + c * f[1] + ty - g[1]));
};

function trimmedRms(r: number[], keep = 0.8): number {
  const s = [...r].sort((a, b) => a - b).slice(0, Math.max(1, Math.floor(r.length * keep)));
  return Math.sqrt(s.reduce((a, v) => a + v * v, 0) / s.length);
}

/** RANSAC over 2-pair minimal sets, then a least-squares refit over the inliers */
function robustFit(pairs: [number[], number[]][], tol: number) {
  let seed = 4242, best: number[] = [];
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let it = 0; it < 200; it++) {
    const i = (rnd() * pairs.length) | 0, j = (rnd() * pairs.length) | 0;
    if (i === j || Math.hypot(pairs[i][0][0] - pairs[j][0][0], pairs[i][0][1] - pairs[j][0][1]) < 0.5) continue;
    const m = kabsch2d([pairs[i][0], pairs[j][0]], [pairs[i][1], pairs[j][1]]);
    const inl = residuals(pairs, m).flatMap((r, k) => (r < tol ? [k] : []));
    if (inl.length > best.length) best = inl;
  }
  if (best.length < 3) best = pairs.map((_, k) => k);
  let fit = kabsch2d(best.map(k => pairs[k][0]), best.map(k => pairs[k][1]));
  for (let round = 0; round < 2; round++) {                     // inliers of the refit, refit again
    const inl = residuals(pairs, fit).flatMap((r, k) => (r < tol ? [k] : []));
    if (inl.length < 3) break;
    best = inl;
    fit = kabsch2d(best.map(k => pairs[k][0]), best.map(k => pairs[k][1]));
  }
  const r = residuals(best.map(k => pairs[k]), fit);
  return { ...fit, inliers: best.length, rms: Math.sqrt(r.reduce((a, v) => a + v * v, 0) / r.length) };
}

/** smaller standard deviation of the positions (principal axes): a walk along one line can't fix the yaw */
function spread(s: WalkSample[]): number {
  const n = s.length, mx = s.reduce((a, p) => a + p.x, 0) / n, my = s.reduce((a, p) => a + p.y, 0) / n;
  let xx = 0, xy = 0, yy = 0;
  for (const p of s) { xx += (p.x - mx) ** 2; xy += (p.x - mx) * (p.y - my); yy += (p.y - my) ** 2; }
  xx /= n; xy /= n; yy /= n;
  return Math.sqrt(Math.max(0, (xx + yy) / 2 - Math.sqrt(((xx - yy) / 2) ** 2 + xy * xy)));
}

export function alignWalks(ref: WalkSample[], other: WalkSample[], o: WalkOptions = {}): WalkAlignment | null {
  const maxLag = o.maxLag ?? 0.3, minPairs = o.minPairs ?? 30, tol = o.inlierTol ?? 0.25, maxGap = o.maxGap ?? 0.35;
  let bestDt = 0, bestScore = Infinity;
  const score = (dt: number) => {
    const p = pairsAt(ref, other, dt, maxGap);
    return p.length < minPairs ? Infinity : trimmedRms(residuals(p, kabsch2d(p.map(q => q[0]), p.map(q => q[1]))));
  };
  for (let dt = -maxLag; dt <= maxLag + 1e-9; dt += 0.01) {
    const s = score(dt);
    if (s < bestScore) { bestScore = s; bestDt = dt; }
  }
  if (!isFinite(bestScore)) return null;
  for (let dt = bestDt - 0.01; dt <= bestDt + 0.01 + 1e-9; dt += 0.001) {
    const s = score(dt);
    if (s < bestScore) { bestScore = s; bestDt = dt; }
  }
  const pairs = pairsAt(ref, other, bestDt, maxGap);
  const fit = robustFit(pairs, tol);
  return { theta: fit.theta, tx: fit.tx, ty: fit.ty, dt: bestDt, rms: fit.rms, pairs: pairs.length,
           inliers: fit.inliers, spread: spread(ref) };
}
