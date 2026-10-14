// Points, layer lines and the organized triangle mesh of one processed scan, as plain typed arrays
// (three.js-independent). All three share one position/colour/normal buffer (vertex = grid index) and
// differ only in their index lists.
import { AREA_COLORS, turbo } from "../core/colors";
import { sameTol } from "../core/math";
import type { RGB } from "../core/types";
import type { Grid } from "../pipeline/grid";

export type ColorBy = "uniform" | "rssi" | "dist" | "height" | "layer" | "noise" | "conf" | "area";
export const UNIFORM: RGB = [0.78, 0.8, 0.83];

export interface GeometryOptions {
  colorBy: ColorBy;
  layer: number;               // -1 = all
  maxRange: number;
  jump: number; jumpRel: number;
  tint?: (i: number, rgb: RGB) => RGB;
}

export interface Geometry {
  N: number;
  pos: Float32Array; col: Float32Array; nrm: Float32Array;
  pIdx: Uint32Array; lIdx: Uint32Array; tIdx: Uint32Array;
  vis: Uint8Array;
  np: number; nl: number; nt: number;         // points, line segments, triangles
  lo: number; hi: number;                     // colour scale range
  areaCounts: [number, number, number];
}

export function createGeometry(N: number): Geometry {
  return { N, pos: new Float32Array(N * 3), col: new Float32Array(N * 3), nrm: new Float32Array(N * 3),
    pIdx: new Uint32Array(N), lIdx: new Uint32Array(N * 2), tIdx: new Uint32Array(N * 6), vis: new Uint8Array(N),
    np: 0, nl: 0, nt: 0, lo: 0, hi: 1, areaCounts: [0, 0, 0] };
}

/** value used for colouring beam i (before scaling) */
function colorValue(g: Grid, i: number, d: number, z: number, l: number, by: ColorBy): number {
  switch (by) {
    case "area": return g.area[i];
    case "rssi": return g.rssi[i];
    case "dist": return d;
    case "height": return z;
    case "noise": return Math.sqrt(g.noiseVar[i]) * 1000;
    case "conf": return g.conf[i];
    default: return l;
  }
}

export function buildGeometry(g: Grid, D: Float32Array, geo: Geometry, o: GeometryOptions): Geometry {
  const { L, B, N, rayX, rayY, rayZ } = g;
  const P = geo.pos, C = geo.col, Nn = geo.nrm, vis = geo.vis;
  const vals = new Float32Array(N);
  let np = 0, nl = 0, nt = 0;
  const jumpOk = (a: number, b: number) => Math.abs(D[a] - D[b]) <= sameTol(Math.min(D[a], D[b]), o.jump, o.jumpRel);

  for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
    const i = l * B + b, d = D[i];
    const ok = d > 0 && d <= o.maxRange && (o.layer < 0 || o.layer === l);
    vis[i] = ok ? 1 : 0;
    if (!ok) continue;
    P[3 * i] = rayX[i] * d; P[3 * i + 1] = rayY[i] * d; P[3 * i + 2] = rayZ[i] * d;
    vals[i] = colorValue(g, i, d, P[3 * i + 2], l, o.colorBy);
    geo.pIdx[np++] = i;
    if (b > 0 && vis[i - 1] && jumpOk(i, i - 1)) { geo.lIdx[2 * nl] = i - 1; geo.lIdx[2 * nl + 1] = i; nl++; }
  }

  // organized fast mesh: each grid cell (2 beams × 2 layers) → up to two triangles, split along the
  // shorter diagonal; triangles spanning a depth jump are dropped. Normals: area-weighted sums.
  Nn.fill(0);
  const addTri = (a: number, b: number, c: number) => {
    geo.tIdx[3 * nt] = a; geo.tIdx[3 * nt + 1] = b; geo.tIdx[3 * nt + 2] = c; nt++;
    const ax = P[3 * a], ay = P[3 * a + 1], az = P[3 * a + 2];
    const ux = P[3 * b] - ax, uy = P[3 * b + 1] - ay, uz = P[3 * b + 2] - az;
    const vx = P[3 * c] - ax, vy = P[3 * c + 1] - ay, vz = P[3 * c + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { Nn[3 * k] += nx; Nn[3 * k + 1] += ny; Nn[3 * k + 2] += nz; }
  };
  for (let l = 0; l < L - 1; l++) for (let b = 0; b < B - 1; b++) {
    const a = l * B + b, r = a + 1, u = a + B, ur = u + 1;
    const diag1 = vis[a] && vis[ur] && jumpOk(a, ur);
    const diag2 = vis[r] && vis[u] && jumpOk(r, u);
    const useFirst = diag1 && (!diag2 || Math.abs(D[a] - D[ur]) <= Math.abs(D[r] - D[u]));
    if (useFirst) {
      if (vis[r] && jumpOk(a, r) && jumpOk(r, ur)) addTri(a, r, ur);
      if (vis[u] && jumpOk(a, u) && jumpOk(u, ur)) addTri(a, ur, u);
    } else if (diag2) {
      if (vis[a] && jumpOk(a, r) && jumpOk(a, u)) addTri(a, r, u);
      if (vis[ur] && jumpOk(r, ur) && jumpOk(u, ur)) addTri(r, ur, u);
    }
  }
  for (let i = 0; i < N; i++) {
    const x = Nn[3 * i], y = Nn[3 * i + 1], z = Nn[3 * i + 2], s = Math.hypot(x, y, z);
    if (s > 0) { Nn[3 * i] = x / s; Nn[3 * i + 1] = y / s; Nn[3 * i + 2] = z / s; }
    else { Nn[3 * i] = -rayX[i]; Nn[3 * i + 1] = -rayY[i]; Nn[3 * i + 2] = -rayZ[i]; }
  }

  // colours: robust 2nd..98th percentile scaling
  let lo = 0, hi = 1;
  if (o.colorBy === "layer") { lo = 0; hi = L - 1; }
  else if (o.colorBy === "conf") { lo = 0; hi = 1; }
  else if (o.colorBy !== "uniform" && o.colorBy !== "area" && np) {
    const step = Math.max(1, Math.floor(np / 4000)), s: number[] = [];
    for (let k = 0; k < np; k += step) s.push(vals[geo.pIdx[k]]);
    s.sort((x, y) => x - y);
    lo = s[Math.floor(s.length * 0.02)]; hi = s[Math.floor(s.length * 0.98)];
    if (hi <= lo) hi = lo + 1;
  }
  const counts: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < np; k++) {
    const i = geo.pIdx[k];
    let rgb: RGB = o.colorBy === "uniform" ? UNIFORM : o.colorBy === "area" ? AREA_COLORS[vals[i]] : turbo((vals[i] - lo) / (hi - lo));
    if (o.colorBy === "area") counts[vals[i]]++;
    if (o.tint) rgb = o.tint(i, rgb);
    C[3 * i] = rgb[0]; C[3 * i + 1] = rgb[1]; C[3 * i + 2] = rgb[2];
  }
  Object.assign(geo, { np, nl, nt, lo, hi, areaCounts: counts });
  return geo;
}
