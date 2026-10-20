// One wall where several sensors see the same one. Each sensor's mesh of a shared static surface lies a few
// mm to a cm off the others' (noise, calibration), so the two interleave and flicker. Two steps make it one:
//  1. interpolate: each point moves along its own beam onto the fused surface, the weighted mean of every
//     sensor's estimate there (per voxel: that sensor's mean point and normal; weight (|n·u|/distance)², so a
//     close, frontal view counts most). All sensors' points then lie on the same surface: no step at a seam.
//  2. show it once: each spot is drawn by the sensor that sees it best (the same quality, computed exactly
//     from each sensor's position, so the handover is a smooth line, not voxel patches); the others hide
//     their beams there, except a one-beam band along the seam so the two triangulations leave no crack.
// Only static surfaces (each sensor's remembered wall or empty scene) take part; computed about once a
// second (docs/multisensor.md).
import type { Pose } from "./pose";

export interface SurfaceInput {
  pose: Pose;
  L: number; B: number;
  rayX: Float32Array; rayY: Float32Array; rayZ: Float32Array;
  range: Float32Array;            // static range per beam (0 = none)
}

export interface SurfaceMerge {
  ref: Float32Array;              // the static range it was computed for
  fused: Float32Array;            // range on the fused surface (0 = not shared with another sensor)
  hide: Uint8Array;               // 1 = another sensor draws this spot
  shared: number; hidden: number; // beams on a shared surface, hidden ones
}

export interface MergeOptions { voxel?: number; tol?: number; minCount?: number; minCos?: number }

export function mergeSurfaces(inputs: SurfaceInput[], o: MergeOptions = {}): SurfaceMerge[] {
  const voxel = o.voxel ?? 0.15, tol = o.tol ?? 0.06, minCount = o.minCount ?? 4, minCos = o.minCos ?? 0.15;
  const S = inputs.length;
  // world point, normal (towards its sensor) and view direction per beam
  const geo = inputs.map(s => beamNormals(s));
  const origin = inputs.map(s => s.pose.t);
  // per voxel and sensor: count, sum of points, sum of normals (7 values per sensor, voxels numbered as found)
  const vox = new VoxelTable(7 * S);
  const cellOf = (v: number) => Math.min(2047, Math.max(0, Math.floor(v / voxel) + 1024));      // ±150 m at 0.15 m
  const vids = geo.map((g, k) => {
    const vid = new Int32Array(g.has.length).fill(-1);
    for (let i = 0; i < g.has.length; i++) {
      if (!g.ok[i]) continue;
      vid[i] = vox.id(cellOf(g.w[3 * i]), cellOf(g.w[3 * i + 1]), cellOf(g.w[3 * i + 2]), true);
      const a = vox.data, b = vid[i] * 7 * S + 7 * k;
      a[b]++;
      for (let c = 0; c < 3; c++) { a[b + 1 + c] += g.w[3 * i + c]; a[b + 4 + c] += g.n[3 * i + c]; }
    }
    return vid;
  });
  geo.forEach((g, k) => {                // beams without a normal of their own: only where some sensor has one
    for (let i = 0; i < g.has.length; i++)
      if (g.has[i] && !g.ok[i]) vids[k][i] = vox.id(cellOf(g.w[3 * i]), cellOf(g.w[3 * i + 1]), cellOf(g.w[3 * i + 2]), false);
  });
  const A = vox.data;
  return inputs.map((s, k) => {
    const g = geo[k], vid = vids[k], N = s.L * s.B, fused = new Float32Array(N), cand = new Uint8Array(N);
    const d = new Float64Array(S), q = new Float64Array(S);
    let shared = 0;
    for (let i = 0; i < N; i++) {
      if (vid[i] < 0) continue;
      const a0 = vid[i] * 7 * S;
      const px = g.w[3 * i], py = g.w[3 * i + 1], pz = g.w[3 * i + 2];
      let nx = g.n[3 * i], ny = g.n[3 * i + 1], nz = g.n[3 * i + 2];
      if (!g.ok[i]) {        // no normal of its own (an edge, seen edge-on): its sensor's there, else another's
        let src = -1;
        for (let j = 0; j < S; j++) if (A[a0 + 7 * j] >= minCount && (src < 0 || j === k)) src = j;
        if (src < 0) continue;
        const b = a0 + 7 * src, ml = Math.sqrt(A[b + 4] * A[b + 4] + A[b + 5] * A[b + 5] + A[b + 6] * A[b + 6]);
        if (ml < 0.9 * A[b]) continue;                                                          // not flat
        const sg = A[b + 4] * g.u[3 * i] + A[b + 5] * g.u[3 * i + 1] + A[b + 6] * g.u[3 * i + 2] > 0 ? -1 : 1;
        nx = sg * A[b + 4] / ml; ny = sg * A[b + 5] / ml; nz = sg * A[b + 6] / ml;
      }
      let seen = 0;
      for (let j = 0; j < S; j++) {
        const b = a0 + 7 * j, c = A[b];
        d[j] = NaN;
        if (j !== k && c < minCount) continue;
        if (j !== k) {
          const ml = Math.sqrt(A[b + 4] * A[b + 4] + A[b + 5] * A[b + 5] + A[b + 6] * A[b + 6]);
          if ((nx * A[b + 4] + ny * A[b + 5] + nz * A[b + 6]) < 0.9 * ml) continue;              // other side, or not flat
        }
        const off = j === k ? 0 : nx * (A[b + 1] / c - px) + ny * (A[b + 2] / c - py) + nz * (A[b + 3] / c - pz);
        if (Math.abs(off) > tol) continue;                                                     // another surface
        const ox = px - origin[j][0], oy = py - origin[j][1], oz = pz - origin[j][2];
        d[j] = off; q[j] = Math.abs(nx * ox + ny * oy + nz * oz) / (ox * ox + oy * oy + oz * oz);   // |n·u| / distance
        if (j !== k) seen++;
      }
      if (!seen) continue;
      let sw = 0, sd = 0, best = k;
      for (let j = 0; j < S; j++) {
        if (isNaN(d[j])) continue;
        sw += q[j] * q[j]; sd += q[j] * q[j] * d[j];
        if (q[j] > q[best] || (q[j] === q[best] && j < best)) best = j;
      }
      const along = nx * g.u[3 * i] + ny * g.u[3 * i + 1] + nz * g.u[3 * i + 2];             // < 0: n faces the sensor
      fused[i] = s.range[i] + (along < -0.1 ? (sd / sw) / along : 0);   // seen edge-on: hidden or kept, not moved
      cand[i] = best === k ? 0 : 1;
      shared++;
    }
    // hide only where the neighbours along and across the layer are hidden too: a one-beam overlap at the seam
    const hide = new Uint8Array(N);
    let hidden = 0;
    for (let l = 0; l < s.L; l++) for (let b = 0; b < s.B; b++) {
      const i = l * s.B + b;
      if (!cand[i]) continue;
      const ok = (j: number) => cand[j] || !g.has[j];
      if ((b === 0 || ok(i - 1)) && (b === s.B - 1 || ok(i + 1)) && (l === 0 || ok(i - s.B)) && (l === s.L - 1 || ok(i + s.B))) { hide[i] = 1; hidden++; }
    }
    return { ref: Float32Array.from(s.range), fused, hide, shared, hidden };
  });

  /** per beam: world point and view direction (has), and where the grid neighbours give one, the unit normal
   *  facing the sensor (ok) */
  function beamNormals(s: SurfaceInput) {
    const { L, B, rayX: X, rayY: Y, rayZ: Z, range: R, pose } = s, N = L * B, { R: M, t } = pose;
    const w = new Float32Array(3 * N), n = new Float32Array(3 * N), u = new Float32Array(3 * N), ok = new Uint8Array(N), has = new Uint8Array(N);
    const same = (i: number, j: number, across: boolean) => R[j] > 0 && Math.abs(R[j] - R[i]) <= (across ? 0.1 + 0.1 * R[i] : 0.05 + 0.03 * R[i]);
    for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
      const i = l * B + b, r = R[i];
      if (!(r > 0)) continue;
      const x = X[i] * r, y = Y[i] * r, z = Z[i] * r;
      w[3 * i] = M[0] * x + M[1] * y + M[2] * z + t[0]; w[3 * i + 1] = M[3] * x + M[4] * y + M[5] * z + t[1]; w[3 * i + 2] = M[6] * x + M[7] * y + M[8] * z + t[2];
      u[3 * i] = M[0] * X[i] + M[1] * Y[i] + M[2] * Z[i]; u[3 * i + 1] = M[3] * X[i] + M[4] * Y[i] + M[5] * Z[i]; u[3 * i + 2] = M[6] * X[i] + M[7] * Y[i] + M[8] * Z[i];
      has[i] = 1;
      const b0 = Math.max(0, b - 2), b1 = Math.min(B - 1, b + 2), l0 = Math.max(0, l - 1), l1 = Math.min(L - 1, l + 1);
      const i0 = l * B + b0, i1 = l * B + b1, j0 = l0 * B + b, j1 = l1 * B + b;
      if (b1 === b0 || l1 === l0 || !same(i, i0, false) || !same(i, i1, false) || !same(i, j0, true) || !same(i, j1, true)) continue;
      const ex = X[i1] * R[i1] - X[i0] * R[i0], ey = Y[i1] * R[i1] - Y[i0] * R[i0], ez = Z[i1] * R[i1] - Z[i0] * R[i0];
      const fx = X[j1] * R[j1] - X[j0] * R[j0], fy = Y[j1] * R[j1] - Y[j0] * R[j0], fz = Z[j1] * R[j1] - Z[j0] * R[j0];
      let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len < 1e-12) continue;
      nx /= len; ny /= len; nz /= len;
      const dot = nx * X[i] + ny * Y[i] + nz * Z[i];
      if (Math.abs(dot) < minCos) continue;                                     // seen edge-on: too uncertain
      if (dot > 0) { nx = -nx; ny = -ny; nz = -nz; }
      n[3 * i] = M[0] * nx + M[1] * ny + M[2] * nz; n[3 * i + 1] = M[3] * nx + M[4] * ny + M[5] * nz; n[3 * i + 2] = M[6] * nx + M[7] * ny + M[8] * nz;
      ok[i] = 1;
    }
    return { w, n, u, ok, has };
  }
}

/** voxels by their cell (x, y, z each 0..2047), numbered in the order found, with `stride` sums each: an open-
 *  addressing hash on the three cell numbers (a Map keyed by one number above 2^31 hashes heap numbers: slow) */
class VoxelTable {
  private keys = new Int32Array(1 << 14).fill(-1);       // slot → voxel number, −1 = empty
  private cells = new Int32Array(3 << 12);               // voxel number → its cell
  data = new Float64Array(0);
  count = 0;
  constructor(stride: number) { this.data = new Float64Array(stride << 12); }

  /** the voxel number of a cell; `add`: create it when new (else −1) */
  id(x: number, y: number, z: number, add: boolean): number {
    let mask = this.keys.length - 1, h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
    for (;; h = (h + 1) & mask) {
      const v = this.keys[h];
      if (v < 0) break;
      if (this.cells[3 * v] === x && this.cells[3 * v + 1] === y && this.cells[3 * v + 2] === z) return v;
    }
    if (!add) return -1;
    if (2 * (this.count + 1) > this.keys.length) { this.grow(); mask = this.keys.length - 1; h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask; while (this.keys[h] >= 0) h = (h + 1) & mask; }
    const v = this.count++;
    if (3 * this.count > this.cells.length) {
      const c = new Int32Array(2 * this.cells.length); c.set(this.cells); this.cells = c;
      const d = new Float64Array(2 * this.data.length); d.set(this.data); this.data = d;
    }
    this.keys[h] = v; this.cells[3 * v] = x; this.cells[3 * v + 1] = y; this.cells[3 * v + 2] = z;
    return v;
  }

  private grow(): void {
    const keys = new Int32Array(2 * this.keys.length).fill(-1), mask = keys.length - 1;
    for (let v = 0; v < this.count; v++) {
      const x = this.cells[3 * v], y = this.cells[3 * v + 1], z = this.cells[3 * v + 2];
      let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
      while (keys[h] >= 0) h = (h + 1) & mask;
      keys[h] = v;
    }
    this.keys = keys;
  }
}
