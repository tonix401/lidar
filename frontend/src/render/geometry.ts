// Points, layer lines and the organized triangle mesh of one processed scan, as plain typed arrays
// (three.js-independent). All three share one position/colour/normal buffer and differ only in their index
// lists. Vertex i (< N) is beam i; vertex N + i is the remembered wall behind beam i (`fill`), drawn where
// a moving object hides it and meshed together with the surrounding wall.
import { AREA_COLORS, scale, trackColor, turbo } from "../core/colors";
import { sameTol } from "../core/math";
import type { RGB } from "../core/types";
import type { Grid } from "../pipeline/grid";

export type ColorBy = "uniform" | "rssi" | "dist" | "height" | "layer" | "noise" | "conf" | "area" | "cell";
export const UNIFORM: RGB = [0.78, 0.8, 0.83];
/** categorical colour-bys: no colour scale */
const CATEGORICAL: ReadonlySet<ColorBy> = new Set<ColorBy>(["uniform", "area", "cell"]);

export interface GeometryOptions {
  colorBy: ColorBy;
  layer: number;               // -1 = all
  maxRange: number;
  jump: number; jumpRel: number;
  tint?: (i: number, rgb: RGB) => RGB;
  cells?: Int32Array | null;   // radial-cell slot per beam (−1 = none), for colorBy "cell"
  fill?: Float32Array | null;  // remembered wall range per beam to draw behind moving objects (0 = none)
  fillTint?: (rgb: RGB) => RGB;
  front?: Uint8Array | null;   // beams in front of the empty scene (1): no triangle joins them to the rest
  seesWall?: Uint8Array | null;   // beams whose return matches their remembered wall: the fill is only joined to those
}

/** a triangle of beams in front, seen this close to edge-on (|normal · ray| below this), shows range noise
 *  along the beam rather than surface (the spikes at a person's sides): it is not drawn (the points are) */
export const FRONT_GRAZING = 0.12;

export const FILL_DIM = 0.8;   // remembered walls are drawn a little darker than measured ones

export interface Geometry {
  N: number;                                  // beams; vertices are 2N (see top)
  pos: Float32Array; col: Float32Array; nrm: Float32Array;
  pIdx: Uint32Array; lIdx: Uint32Array; tIdx: Uint32Array;
  vis: Uint8Array;
  np: number; nl: number; nt: number;         // points, line segments, triangles
  lo: number; hi: number;                     // colour scale range
  areaCounts: [number, number, number];
}

export function createGeometry(N: number): Geometry {
  return { N, pos: new Float32Array(N * 6), col: new Float32Array(N * 6), nrm: new Float32Array(N * 6),
    pIdx: new Uint32Array(N * 2), lIdx: new Uint32Array(N * 2), tIdx: new Uint32Array(N * 12), vis: new Uint8Array(N),
    np: 0, nl: 0, nt: 0, lo: 0, hi: 1, areaCounts: [0, 0, 0] };
}

/** value used for colouring beam i (before scaling) */
function colorValue(g: Grid, i: number, d: number, z: number, l: number, o: GeometryOptions): number {
  switch (o.colorBy) {
    case "area": return g.area[i];
    case "cell": return o.cells ? o.cells[i] : -1;
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
  const vals = new Float32Array(N), F = o.fill;
  let np = 0, nl = 0, nt = 0;
  const jump = (x: number, y: number) => Math.abs(x - y) <= sameTol(Math.min(x, y), o.jump, o.jumpRel);
  const jumpOk = (a: number, b: number) => jump(D[a], D[b]);
  const inView = (d: number, l: number) => d > 0 && d <= o.maxRange && (o.layer < 0 || o.layer === l);

  for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
    const i = l * B + b, d = D[i];
    const ok = inView(d, l);
    vis[i] = ok ? 1 : 0;
    if (!ok) continue;
    P[3 * i] = rayX[i] * d; P[3 * i + 1] = rayY[i] * d; P[3 * i + 2] = rayZ[i] * d;
    vals[i] = colorValue(g, i, d, P[3 * i + 2], l, o);
    geo.pIdx[np++] = i;
    if (b > 0 && vis[i - 1] && jumpOk(i, i - 1)) { geo.lIdx[2 * nl] = i - 1; geo.lIdx[2 * nl + 1] = i; nl++; }
  }
  const npMain = np;
  if (F) for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
    const i = l * B + b, d = F[i], v = N + i;
    if (!inView(d, l)) continue;
    P[3 * v] = rayX[i] * d; P[3 * v + 1] = rayY[i] * d; P[3 * v + 2] = rayZ[i] * d;
    geo.pIdx[np++] = v;
  }

  // organized fast mesh: each grid cell (2 beams × 2 layers) → up to two triangles, split along the
  // shorter diagonal; triangles spanning a depth jump are dropped. Normals: area-weighted sums.
  Nn.fill(0);
  let fillPass = false;                                   // then only triangles touching a remembered vertex
  const Fr = o.front, side = (v: number) => v < N && Fr![v] === 1;   // remembered wall: never in front
  const addTri = (a: number, b: number, c: number) => {
    if (fillPass && a < N && b < N && c < N) return;
    if (Fr && (side(a) !== side(b) || side(a) !== side(c))) return;   // across an object's outline
    const ax = P[3 * a], ay = P[3 * a + 1], az = P[3 * a + 2];
    const ux = P[3 * b] - ax, uy = P[3 * b + 1] - ay, uz = P[3 * b + 2] - az;
    const vx = P[3 * c] - ax, vy = P[3 * c + 1] - ay, vz = P[3 * c + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (Fr && side(a)) {                                  // edge-on triangle of an object: a spike
      const cx = 3 * ax + ux + vx, cy = 3 * ay + uy + vy, cz = 3 * az + uz + vz;   // 3 × centroid
      if (Math.abs(nx * cx + ny * cy + nz * cz) < FRONT_GRAZING * Math.hypot(nx, ny, nz) * Math.hypot(cx, cy, cz)) return;
    }
    geo.tIdx[3 * nt] = a; geo.tIdx[3 * nt + 1] = b; geo.tIdx[3 * nt + 2] = c; nt++;
    for (const k of [a, b, c]) { Nn[3 * k] += nx; Nn[3 * k + 1] += ny; Nn[3 * k + 2] += nz; }
  };
  /** triangles of one 2×2 cell given its corners' depths (0 = not drawn) and vertex ids */
  const cell = (a: number, r: number, u: number, ur: number, da: number, dr: number, du: number, dur: number) => {
    const diag1 = da > 0 && dur > 0 && jump(da, dur);
    const diag2 = dr > 0 && du > 0 && jump(dr, du);
    if (diag1 && (!diag2 || Math.abs(da - dur) <= Math.abs(dr - du))) {
      if (dr > 0 && jump(da, dr) && jump(dr, dur)) addTri(a, r, ur);
      if (du > 0 && jump(da, du) && jump(du, dur)) addTri(a, ur, u);
    } else if (diag2) {
      if (da > 0 && jump(da, dr) && jump(da, du)) addTri(a, r, u);
      if (dur > 0 && jump(dr, dur) && jump(du, dur)) addTri(r, ur, u);
    }
  };
  for (let l = 0; l < L - 1; l++) for (let b = 0; b < B - 1; b++) {
    const a = l * B + b, r = a + 1, u = a + B, ur = u + 1;
    cell(a, r, u, ur, vis[a] ? D[a] : 0, vis[r] ? D[r] : 0, vis[u] ? D[u] : 0, vis[ur] ? D[ur] : 0);
  }
  // remembered wall: cells with a filled corner, joined to the measured wall around it
  const filled = (i: number, l: number) => !!F && inView(F[i], l);
  const SW = o.seesWall, seesWall = (i: number) => !SW || SW[i] === 1;
  fillPass = true;
  if (F) for (let l = 0; l < L - 1; l++) for (let b = 0; b < B - 1; b++) {
    const a = l * B + b, r = a + 1, u = a + B, ur = u + 1;
    const fa = filled(a, l), fr = filled(r, l), fu = filled(u, l + 1), fur = filled(ur, l + 1);
    if (!fa && !fr && !fu && !fur) continue;
    const dep = (i: number, f: boolean) => f ? F[i] : vis[i] && seesWall(i) ? D[i] : 0, id = (i: number, f: boolean) => f ? N + i : i;
    cell(id(a, fa), id(r, fr), id(u, fu), id(ur, fur), dep(a, fa), dep(r, fr), dep(u, fu), dep(ur, fur));
  }
  for (let i = 0; i < 2 * N; i++) {
    const x = Nn[3 * i], y = Nn[3 * i + 1], z = Nn[3 * i + 2], s = Math.hypot(x, y, z);
    if (s > 0) { Nn[3 * i] = x / s; Nn[3 * i + 1] = y / s; Nn[3 * i + 2] = z / s; }
    else { const j = i % N; Nn[3 * i] = -rayX[j]; Nn[3 * i + 1] = -rayY[j]; Nn[3 * i + 2] = -rayZ[j]; }
  }

  // colours: robust 2nd..98th percentile scaling
  let lo = 0, hi = 1;
  if (o.colorBy === "layer") { lo = 0; hi = L - 1; }
  else if (o.colorBy === "conf") { lo = 0; hi = 1; }
  else if (!CATEGORICAL.has(o.colorBy) && npMain) {
    const step = Math.max(1, Math.floor(npMain / 4000)), s: number[] = [];
    for (let k = 0; k < npMain; k += step) s.push(vals[geo.pIdx[k]]);
    s.sort((x, y) => x - y);
    lo = s[Math.floor(s.length * 0.02)]; hi = s[Math.floor(s.length * 0.98)];
    if (hi <= lo) hi = lo + 1;
  }
  const counts: [number, number, number] = [0, 0, 0];
  const color = (v: number): RGB => o.colorBy === "uniform" ? UNIFORM : o.colorBy === "area" ? AREA_COLORS[v]
    : o.colorBy === "cell" ? (v < 0 ? scale(UNIFORM, 0.35) : trackColor(v + 1)) : turbo((v - lo) / (hi - lo));
  for (let k = 0; k < npMain; k++) {
    const i = geo.pIdx[k];
    let rgb = color(vals[i]);
    if (o.colorBy === "area") counts[vals[i]]++;
    if (o.tint) rgb = o.tint(i, rgb);
    C[3 * i] = rgb[0]; C[3 * i + 1] = rgb[1]; C[3 * i + 2] = rgb[2];
  }
  for (let k = npMain; k < np; k++) {                       // remembered wall: a static surface, never an object
    const v = geo.pIdx[k], i = v - N, l = (i / B) | 0, d = F![i];
    const val = o.colorBy === "area" ? 1 : o.colorBy === "cell" ? -1 : colorValue(g, i, d, P[3 * v + 2], l, o);
    let rgb = scale(color(val), FILL_DIM);
    if (o.fillTint) rgb = o.fillTint(rgb);
    C[3 * v] = rgb[0]; C[3 * v + 1] = rgb[1]; C[3 * v + 2] = rgb[2];
  }
  Object.assign(geo, { np, nl, nt, lo, hi, areaCounts: counts });
  return geo;
}
