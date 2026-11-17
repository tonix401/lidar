// Calibration step 3: the static scene → a sensor's four degrees of freedom (x, y, z, yaw; every sensor is
// level), to centimetres. Point-to-plane ICP (Chen & Medioni 1992): each point of one sensor's empty scene is
// matched to the nearest point of the others' and pulled onto that point's tangent plane; a Gauss–Newton step on
// the linearised motion solves all matches at once, over shrinking match distances. The closest share of the
// matches is kept, and those are weighted by a Huber kernel, so a few wrong matches pull less than the many right
// ones. Directions the scene does not constrain (along a corridor, the height when the sensors share only walls)
// show as near-zero eigenvalues of the normal matrix; the step leaves them out (Zhang et al. 2016, "On degeneracy
// of optimization-based state estimation problems"), so they keep the walk's and the floor's estimate.
import { smallestEigenvector } from "../../core/math";
import { symEigen } from "../linalg";
import { compose, fromParams, rotate, type Pose } from "../pose";
import { DEG } from "../../core/math";

/** points with unit normals (pointing towards the sensor that saw them), and the layer of each */
export interface Cloud { p: Float32Array; n: Float32Array; layer: Uint8Array; count: number }

export interface CloudOptions { voxel?: number; wb?: number; maxRange?: number; maxCurvature?: number }

/** the flat-surface points of an organized range image (sensor frame), one per `voxel`. Normals by PCA over
 *  same-surface neighbours: ±wb beams along the layer, ±1 layer. Some of them must be in another layer:
 *  beams of one layer alone lie on a line, whose "normal" is any direction around it. Across layers the
 *  same-surface range tolerance is wider (10 %): on a floor seen at a grazing angle, the next layer lands
 *  ~0.3 m further out at 6 m. A patch mixing two surfaces then fails the flatness test. */
export function gridCloud(range: Float32Array, rayX: Float32Array, rayY: Float32Array, rayZ: Float32Array, L: number, B: number,
                          o: CloudOptions = {}): Cloud {
  const voxel = o.voxel ?? 0.05, wb = o.wb ?? 4, maxRange = o.maxRange ?? 30, maxCurv = o.maxCurvature ?? 0.02;
  const p: number[] = [], nrm: number[] = [], lay: number[] = [], seen = new Set<string>(), out = [0, 0, 0];
  for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
    const i = l * B + b, r = range[i];
    if (!(r > 0.3 && r < maxRange)) continue;
    const x = rayX[i] * r, y = rayY[i] * r, z = rayZ[i] * r;
    const key = `${Math.floor(x / voxel)},${Math.floor(y / voxel)},${Math.floor(z / voxel)}`;
    if (seen.has(key)) continue;
    let k = 0, across = 0, mx = 0, my = 0, mz = 0;
    const nb: number[] = [];
    for (let ll = Math.max(0, l - 1); ll <= Math.min(L - 1, l + 1); ll++)
      for (let bb = Math.max(0, b - wb); bb <= Math.min(B - 1, b + wb); bb++) {
        const j = ll * B + bb, rj = range[j];
        if (!(rj > 0) || Math.abs(rj - r) > (ll === l ? 0.05 + 0.02 * r : 0.1 + 0.1 * r)) continue;
        const px = rayX[j] * rj, py = rayY[j] * rj, pz = rayZ[j] * rj;
        nb.push(px, py, pz); mx += px; my += py; mz += pz; k++;
        if (ll !== l) across++;
      }
    if (k < 8 || across < 3) continue;
    mx /= k; my /= k; mz /= k;
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (let q = 0; q < nb.length; q += 3) {
      const a = nb[q] - mx, c = nb[q + 1] - my, e = nb[q + 2] - mz;
      xx += a * a; xy += a * c; xz += a * e; yy += c * c; yz += c * e; zz += e * e;
    }
    const curv = smallestEigenvector(xx, xy, xz, yy, yz, zz, out);
    if (curv < 0 || curv > maxCurv) continue;
    const s = out[0] * x + out[1] * y + out[2] * z > 0 ? -1 : 1;           // towards the sensor
    seen.add(key);
    p.push(x, y, z); nrm.push(s * out[0], s * out[1], s * out[2]); lay.push(l);
  }
  return { p: Float32Array.from(p), n: Float32Array.from(nrm), layer: Uint8Array.from(lay), count: p.length / 3 };
}

export function transformCloud(c: Cloud, pose: Pose): Cloud {
  const p = new Float32Array(c.p.length), n = new Float32Array(c.n.length), { R, t } = pose;
  for (let i = 0; i < c.p.length; i += 3) {
    const x = c.p[i], y = c.p[i + 1], z = c.p[i + 2], a = c.n[i], b = c.n[i + 1], e = c.n[i + 2];
    p[i] = R[0] * x + R[1] * y + R[2] * z + t[0]; p[i + 1] = R[3] * x + R[4] * y + R[5] * z + t[1]; p[i + 2] = R[6] * x + R[7] * y + R[8] * z + t[2];
    n[i] = R[0] * a + R[1] * b + R[2] * e; n[i + 1] = R[3] * a + R[4] * b + R[5] * e; n[i + 2] = R[6] * a + R[7] * b + R[8] * e;
  }
  return { p, n, layer: c.layer, count: c.count };
}

export function mergeClouds(cs: Cloud[]): Cloud {
  const count = cs.reduce((a, c) => a + c.count, 0), p = new Float32Array(3 * count), n = new Float32Array(3 * count);
  const layer = new Uint8Array(count);
  let o = 0;
  for (const c of cs) { p.set(c.p, 3 * o); n.set(c.n, 3 * o); layer.set(c.layer, o); o += c.count; }
  return { p, n, layer, count };
}

/** nearest-neighbour search on a hash grid with cells of the search radius (27 cells per query) */
export class VoxelGrid {
  private cells = new Map<number, number[]>();
  constructor(private c: Cloud, private cell: number) {
    for (let i = 0; i < c.count; i++) {
      const k = this.key(Math.floor(c.p[3 * i] / cell), Math.floor(c.p[3 * i + 1] / cell), Math.floor(c.p[3 * i + 2] / cell));
      const v = this.cells.get(k);
      if (v) v.push(i); else this.cells.set(k, [i]);
    }
  }
  private key = (x: number, y: number, z: number) => ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0;
  /** index of the nearest point within `cell`, or −1 */
  nearest(x: number, y: number, z: number): number {
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell), cz = Math.floor(z / this.cell), P = this.c.p;
    let best = -1, bd = this.cell * this.cell;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const v = this.cells.get(this.key(cx + dx, cy + dy, cz + dz));
      if (v) for (const i of v) {
        const d = (P[3 * i] - x) ** 2 + (P[3 * i + 1] - y) ** 2 + (P[3 * i + 2] - z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  }
}

export interface IcpOptions {
  dists?: number[];          // match distances, one stage each (m)
  maxIter?: number;          // per stage
  trim?: number;             // share of the matches kept (the closest)
  huber?: number;            // share of the match distance beyond which a residual's weight falls off (1/|r|)
  minCos?: number;           // |n·n'| of a match
  lever?: number;            // m: weighs a rotation as the motion it causes this far away (degeneracy test)
  degenerate?: number;       // eigenvalue per match below this = not constrained (a direction that 0.3 % of the
                             // matches fix fully, e.g. a few box sides along a corridor, does not count)
}

export interface IcpResult {
  pose: Pose;
  rms: number; median: number;     // residuals of the kept matches, of all matches (m)
  matched: number; overlap: number;
  degenerate: string[];            // directions the scene does not constrain
  iterations: number;
}

const DOF = ["yaw", "x", "y", "z"], N = DOF.length;

/** the step (yaw scaled to m at `L`, then x y z) about the centre c, applied to `pose` */
function stepPose(pose: Pose, s: ArrayLike<number>, o: number, L: number, c: number[]): Pose {
  const dR = fromParams({ x: 0, y: 0, z: 0, yaw: s[o] / L / DEG }), rc = rotate(dR, c);
  return compose({ R: dR.R, t: [c[0] - rc[0] + s[o + 1], c[1] - rc[1] + s[o + 2], c[2] - rc[2] + s[o + 3]] }, pose);
}

/** a match's Jacobian row: yaw (as motion at L) about the centre, then the translation */
const jacobian = (px: number, py: number, n0: number, n1: number, n2: number, L: number) => [(px * n1 - py * n0) / L, n0, n1, n2];

/** Huber weight of a residual */
const huberW = (r: number, k: number) => (Math.abs(r) <= k ? 1 : k / Math.abs(r));

/** refine `init` (source sensor frame → world) so that `source` lies on `target` (world frame) */
export function icp(source: Cloud, target: Cloud, init: Pose, o: IcpOptions = {}): IcpResult {
  const dists = o.dists ?? [0.5, 0.25, 0.1], maxIter = o.maxIter ?? 50, trim = o.trim ?? 0.8, minCos = o.minCos ?? 0.7;
  const L = o.lever ?? 3, minInfo = o.degenerate ?? 0.003, hub = o.huber ?? 0.1;
  let pose = init, iterations = 0, last = { rms: NaN, median: NaN, matched: 0, degenerate: [] as string[] };
  for (const dist of dists) {
    const grid = new VoxelGrid(target, dist);
    for (let it = 0; it < maxIter; it++, iterations++) {
      const w = transformCloud(source, pose), m: { i: number; j: number; r: number }[] = [];
      for (let i = 0; i < w.count; i++) {
        const j = grid.nearest(w.p[3 * i], w.p[3 * i + 1], w.p[3 * i + 2]);
        if (j < 0) continue;
        const nt = [target.n[3 * j], target.n[3 * j + 1], target.n[3 * j + 2]];
        if (Math.abs(nt[0] * w.n[3 * i] + nt[1] * w.n[3 * i + 1] + nt[2] * w.n[3 * i + 2]) < minCos) continue;
        m.push({ i, j, r: nt[0] * (w.p[3 * i] - target.p[3 * j]) + nt[1] * (w.p[3 * i + 1] - target.p[3 * j + 1]) + nt[2] * (w.p[3 * i + 2] - target.p[3 * j + 2]) });
      }
      if (m.length < 30) return { pose: init, rms: NaN, median: NaN, matched: m.length, overlap: m.length / Math.max(1, source.count), degenerate: [...DOF], iterations };
      const abs = m.map(q => Math.abs(q.r)).sort((a, b) => a - b), cut = abs[Math.min(abs.length - 1, Math.floor(abs.length * trim))];
      const kept = m.filter(q => Math.abs(q.r) <= cut);
      let cx = 0, cy = 0, cz = 0;                                // rotate about the matches' centre
      for (const q of kept) { cx += w.p[3 * q.i]; cy += w.p[3 * q.i + 1]; cz += w.p[3 * q.i + 2]; }
      cx /= kept.length; cy /= kept.length; cz /= kept.length;
      const H = new Array<number>(N * N).fill(0), g = new Array<number>(N).fill(0);
      let ss = 0, wsum = 0;
      for (const q of kept) {
        const n0 = target.n[3 * q.j], n1 = target.n[3 * q.j + 1], n2 = target.n[3 * q.j + 2];
        const J = jacobian(w.p[3 * q.i] - cx, w.p[3 * q.i + 1] - cy, n0, n1, n2, L), wt = huberW(q.r, hub * dist);
        for (let a = 0; a < N; a++) { g[a] += wt * J[a] * q.r; for (let b = 0; b < N; b++) H[N * a + b] += wt * J[a] * J[b]; }
        ss += q.r * q.r; wsum += wt;
      }
      const { values, vectors } = symEigen(H, N);
      const step = new Array<number>(N).fill(0), degenerate: string[] = [];
      for (let k = 0; k < N; k++) {
        const v = vectors[k];
        if (values[k] < minInfo * wsum) {                       // unconstrained: leave this direction alone
          let a = 0; for (let c = 1; c < N; c++) if (Math.abs(v[c]) > Math.abs(v[a])) a = c;
          degenerate.push(DOF[a]);
          continue;
        }
        const coef = -v.reduce((s, vi, c) => s + vi * g[c], 0) / values[k];
        for (let c = 0; c < N; c++) step[c] += coef * v[c];
      }
      pose = stepPose(pose, step, 0, L, [cx, cy, cz]);
      last = { rms: Math.sqrt(ss / kept.length), median: abs[abs.length >> 1], matched: m.length, degenerate };
      if (Math.hypot(step[1], step[2], step[3]) < 1e-4 && Math.abs(step[0]) / L < 2e-5) break;
    }
  }
  return { pose, ...last, overlap: last.matched / Math.max(1, source.count), iterations };
}

/** All poses at once (except `fixed`, which defines the world): every sensor's points are matched to every
 *  other sensor's, and one Gauss–Newton step moves all free poses together. Refining one sensor at a time
 *  instead lets two sensors that overlap each other well slide as a block against a third that pins them
 *  only weakly, and each round moves the block only a little. Returns per sensor what `icp` does. */
export function jointIcp(clouds: Cloud[], init: Pose[], fixed = 0, o: IcpOptions = {}): IcpResult[] {
  const dists = o.dists ?? [0.5, 0.25, 0.1], maxIter = o.maxIter ?? 50, trim = o.trim ?? 0.8, minCos = o.minCos ?? 0.7;
  const L = o.lever ?? 3, minInfo = o.degenerate ?? 0.003, hub = o.huber ?? 0.1, S = clouds.length;
  const slot = clouds.map((_, k) => (k === fixed ? -1 : k < fixed ? k : k - 1)), M = N * (S - 1);
  const poses = init.slice();
  let iterations = 0, stats = clouds.map(() => ({ rms: NaN, median: NaN, matched: 0, degenerate: [] as string[] }));
  if (S < 2) return poses.map(pose => ({ pose, ...stats[0], overlap: 0, iterations: 0 }));
  for (const dist of dists) for (let it = 0; it < maxIter; it++, iterations++) {
    const w = clouds.map((c, k) => transformCloud(c, poses[k])), grids = w.map(c => new VoxelGrid(c, dist));
    type Match = { a: number; i: number; b: number; j: number; r: number };
    const kept: Match[] = [], perSensor: number[][] = clouds.map(() => []);
    for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) {
      if (a === b) continue;
      const pa = w[a], pb = w[b], m: Match[] = [];
      for (let i = 0; i < pa.count; i++) {
        const j = grids[b].nearest(pa.p[3 * i], pa.p[3 * i + 1], pa.p[3 * i + 2]);
        if (j < 0) continue;
        const n0 = pb.n[3 * j], n1 = pb.n[3 * j + 1], n2 = pb.n[3 * j + 2];
        if (Math.abs(n0 * pa.n[3 * i] + n1 * pa.n[3 * i + 1] + n2 * pa.n[3 * i + 2]) < minCos) continue;
        m.push({ a, i, b, j, r: n0 * (pa.p[3 * i] - pb.p[3 * j]) + n1 * (pa.p[3 * i + 1] - pb.p[3 * j + 1]) + n2 * (pa.p[3 * i + 2] - pb.p[3 * j + 2]) });
      }
      if (!m.length) continue;
      const abs = m.map(q => Math.abs(q.r)).sort((x, y) => x - y), cut = abs[Math.min(abs.length - 1, Math.floor(abs.length * trim))];
      for (const q of m) { perSensor[a].push(Math.abs(q.r)); if (Math.abs(q.r) <= cut) kept.push(q); }
    }
    if (kept.length < 30) break;
    let cx = 0, cy = 0, cz = 0;                                  // one centre for all rotations
    for (const q of kept) { cx += w[q.a].p[3 * q.i]; cy += w[q.a].p[3 * q.i + 1]; cz += w[q.a].p[3 * q.i + 2]; }
    cx /= kept.length; cy /= kept.length; cz /= kept.length;
    const H = new Array<number>(M * M).fill(0), g = new Array<number>(M).fill(0), ss = clouds.map(() => [0, 0]);
    const J = new Array<number>(2 * N), idx = new Array<number>(2 * N);
    let wsum = 0;
    for (const q of kept) {
      const pb = w[q.b], n0 = pb.n[3 * q.j], n1 = pb.n[3 * q.j + 1], n2 = pb.n[3 * q.j + 2], wt = huberW(q.r, hub * dist);
      let k = 0;
      for (const [s, P, i, sign] of [[q.a, w[q.a], q.i, 1], [q.b, pb, q.j, -1]] as const) {   // r = n·(p_a − p_b)
        if (slot[s] < 0) continue;
        const v = jacobian(P.p[3 * i] - cx, P.p[3 * i + 1] - cy, n0, n1, n2, L), base = N * slot[s];
        for (let c = 0; c < N; c++) { J[k] = sign * v[c]; idx[k++] = base + c; }
      }
      for (let x = 0; x < k; x++) { g[idx[x]] += wt * J[x] * q.r; for (let y = 0; y < k; y++) H[idx[x] * M + idx[y]] += wt * J[x] * J[y]; }
      ss[q.a][0] += q.r * q.r; ss[q.a][1]++; wsum += wt;
    }
    const { values, vectors } = symEigen(H, M), step = new Array<number>(M).fill(0), degenerate = clouds.map(() => [] as string[]);
    for (let e = 0; e < M; e++) {
      const v = vectors[e];
      if (values[e] < minInfo * wsum / (S - 1)) {               // unconstrained: name it after its largest part
        let a = 0; for (let c = 1; c < M; c++) if (Math.abs(v[c]) > Math.abs(v[a])) a = c;
        const s = slot.indexOf(Math.floor(a / N));
        if (!degenerate[s].includes(DOF[a % N])) degenerate[s].push(DOF[a % N]);
        continue;
      }
      const coef = -v.reduce((acc, vi, c) => acc + vi * g[c], 0) / values[e];
      for (let c = 0; c < M; c++) step[c] += coef * v[c];
    }
    let biggest = 0;
    for (let s = 0; s < S; s++) {
      if (slot[s] < 0) continue;
      const b = N * slot[s];
      poses[s] = stepPose(poses[s], step, b, L, [cx, cy, cz]);
      biggest = Math.max(biggest, Math.hypot(step[b + 1], step[b + 2], step[b + 3]) / 1e-4, Math.abs(step[b]) / L / 2e-5);
    }
    stats = clouds.map((_, s) => {
      const r = perSensor[s].sort((x, y) => x - y);
      return { rms: Math.sqrt(ss[s][0] / Math.max(1, ss[s][1])), median: r.length ? r[r.length >> 1] : NaN, matched: r.length, degenerate: degenerate[s] };
    });
    if (biggest < 1) break;
  }
  return poses.map((pose, s) => ({ pose, ...stats[s], overlap: stats[s].matched / Math.max(1, clouds[s].count), iterations }));
}
