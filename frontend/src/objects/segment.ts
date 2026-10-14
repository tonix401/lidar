// Segmentation on the range image (Bogoslavskyi & Stachniss 2016, "depth clustering"): BFS over
// neighbouring foreground beams, joined when the angle β between the line connecting the two points and
// the beam is large (same surface) — as a range difference: d1 − d2·cosψ ≤ d2·sinψ / tanθ + margin (the
// noise margin is needed because our 0.13° beams are closer together than the range noise). Then
// fragments (legs, arms, gaps from dark clothing) are merged when their footprints are < mergeDist apart.
import type { Config } from "../config/config";
import { DEG } from "../core/math";

export interface SegGeometry {
  L: number; B: number;
  rayX: Float32Array; rayY: Float32Array; rayZ: Float32Array;
  elev: Float32Array; stepDeg: number;
}

/** one detected object (after merging) */
export interface Detection {
  segments: number[];          // segment ids (cells: queue[starts[k] .. starts[k+1]))
  n: number;                   // beams
  x: number; y: number; z: number;               // centroid
  bx: number; by: number;                        // box centre (ground plane)
  len: number; wid: number; hgt: number; yaw: number;   // oriented footprint, visible height
  z0: number; z1: number;
  l0: number; l1: number; b0: number; b1: number;       // range-image extent
  clipped: boolean;            // touches the top/bottom layer: height is a lower bound
}

export interface Segmentation { detections: Detection[]; starts: number[]; queue: Int32Array }

export const MAX_MERGED_FOOTPRINT = 1.6;
export const MAX_STATIC_SIZE = 3;

export function segment(geo: SegGeometry, cur: Float32Array, fg: Uint8Array, c: Config["objects"],
                        lab: Int32Array, Q: Int32Array): Segmentation {
  const { L, B, rayX, rayY, rayZ, elev } = geo;
  lab.fill(-1);
  const tanT = Math.tan(c.theta * DEG), psiH = Math.abs(geo.stepDeg) * DEG;
  const join = (p: number, q: number, psi: number) => {
    const a = cur[p], b = cur[q], d1 = Math.max(a, b), d2 = Math.min(a, b);
    return d1 - d2 * Math.cos(psi) <= d2 * Math.sin(psi) / tanT + c.margin;
  };
  const starts: number[] = [];
  let tail = 0;
  for (let s0 = 0; s0 < cur.length; s0++) {
    if (!fg[s0] || lab[s0] >= 0) continue;
    const id = starts.length, start = tail;
    starts.push(start);
    lab[s0] = id; Q[tail++] = s0;
    for (let head = start; head < tail; head++) {
      const p = Q[head], l = (p / B) | 0, b = p - l * B;
      const visit = (q: number, psi: number) => { if (fg[q] && lab[q] < 0 && join(p, q, psi)) { lab[q] = id; Q[tail++] = q; } };
      for (const s of [-1, 1]) {                    // along the layer, looking across up to 2 missing returns
        for (let k = 1; k <= 3; k++) {
          const bb = b + s * k;
          if (bb < 0 || bb >= B) break;
          const q = l * B + bb;
          if (cur[q] > 0) { if (fg[q]) visit(q, k * psiH); break; }
        }
      }
      for (const dl of [-1, 1]) {                   // neighbouring layers (incl. diagonals)
        const ll = l + dl;
        if (ll < 0 || ll >= L) continue;
        for (let db = -1; db <= 1; db++) {
          const bb = b + db;
          if (bb < 0 || bb >= B) continue;
          const q = ll * B + bb;
          visit(q, Math.hypot(Math.abs(elev[q] - elev[p]) * DEG, db * psiH));
        }
      }
    }
  }
  starts.push(tail);

  // per segment: size and xy bounding box
  interface Seg { k: number; n: number; x0: number; x1: number; y0: number; y1: number; root: number }
  const seg: Seg[] = [];
  for (let k = 0; k < starts.length - 1; k++) {
    const n = starts[k + 1] - starts[k];
    if (n < Math.min(3, c.minPoints)) continue;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let h = starts[k]; h < starts[k + 1]; h++) {
      const i = Q[h], d = cur[i], x = rayX[i] * d, y = rayY[i] * d;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    seg.push({ k, n, x0, x1, y0, y1, root: seg.length });
  }
  // merge fragments: union-find on footprint gaps, never growing beyond MAX_MERGED_FOOTPRINT
  const find = (s: number): number => { while (seg[s].root !== s) s = seg[s].root = seg[seg[s].root].root; return s; };
  if (c.mergeDist > 0 && seg.length < 600) {
    const order = seg.map((_, i) => i).sort((a, b) => seg[b].n - seg[a].n);
    for (const a of order) for (const b of order) {
      if (b <= a) continue;
      const ra = find(a), rb = find(b);
      if (ra === rb) continue;
      const A = seg[ra], S = seg[rb];
      const gx = Math.max(0, A.x0 - S.x1, S.x0 - A.x1), gy = Math.max(0, A.y0 - S.y1, S.y0 - A.y1);
      if (Math.hypot(gx, gy) > c.mergeDist) continue;
      const mx0 = Math.min(A.x0, S.x0), mx1 = Math.max(A.x1, S.x1), my0 = Math.min(A.y0, S.y0), my1 = Math.max(A.y1, S.y1);
      if (Math.max(mx1 - mx0, my1 - my0) > MAX_MERGED_FOOTPRINT) continue;
      S.root = ra; A.x0 = mx0; A.x1 = mx1; A.y0 = my0; A.y1 = my1; A.n += S.n;
    }
  }
  // detections: centroid, PCA footprint (oriented box), height, image extent
  const groups = new Map<number, number[]>();
  for (let s = 0; s < seg.length; s++) { const r = find(s); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(seg[s].k); }
  const detections: Detection[] = [];
  for (const ks of groups.values()) {
    let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, syy = 0, z0 = 1e9, z1 = -1e9, l0 = L, l1 = -1, b0 = B, b1 = -1;
    for (const k of ks) for (let h = starts[k]; h < starts[k + 1]; h++) {
      const i = Q[h], d = cur[i], x = rayX[i] * d, y = rayY[i] * d, z = rayZ[i] * d, l = (i / B) | 0, b = i - l * B;
      n++; sx += x; sy += y; sz += z; sxx += x * x; sxy += x * y; syy += y * y;
      if (z < z0) z0 = z; if (z > z1) z1 = z; if (l < l0) l0 = l; if (l > l1) l1 = l; if (b < b0) b0 = b; if (b > b1) b1 = b;
    }
    if (n < c.minPoints) continue;
    const mx = sx / n, my = sy / n, cxx = sxx / n - mx * mx, cxy = sxy / n - mx * my, cyy = syy / n - my * my;
    const yaw = 0.5 * Math.atan2(2 * cxy, cxx - cyy), ux = Math.cos(yaw), uy = Math.sin(yaw);
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (const k of ks) for (let h = starts[k]; h < starts[k + 1]; h++) {
      const i = Q[h], d = cur[i], x = rayX[i] * d - mx, y = rayY[i] * d - my, u = x * ux + y * uy, v = -x * uy + y * ux;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const len = Math.max(0.05, u1 - u0), wid = Math.max(0.05, v1 - v0);
    if (c.scope === 1 && Math.max(len, wid) > MAX_STATIC_SIZE) continue;     // walls/large structures are not objects
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    detections.push({ segments: ks, n, x: mx, y: my, z: sz / n, bx: mx + cu * ux - cv * uy, by: my + cu * uy + cv * ux,
      len, wid, hgt: z1 - z0, yaw, z0, z1, l0, l1, b0, b1, clipped: l0 === 0 || l1 === L - 1 });
  }
  return { detections, starts, queue: Q };
}
