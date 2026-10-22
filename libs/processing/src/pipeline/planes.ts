// Plane flattening (local PCA plane fit, an MLS-style projection). For each point: gather same-surface
// neighbours in a window, fit a plane, and if the patch is planar enough move the point along its own
// laser ray onto that plane. Also classifies g.area (0 flat · 1 detail · 2 moving).
import type { Config } from "../config/config";
import type { StageDef } from "../config/types";
import { DEG, sameTol, smallestEigenvector } from "../core/math";
import { beamState } from "./beamState";
import type { Grid } from "./grid";

export type PlanesConfig = { on: boolean; wb: number; wl: number; planarity: number; minPts: number; minCos: number; tolAbs: number; tolRel: number; noiseFlat: number };

export const planesStage: StageDef<"planes"> = {
  key: "planes", title: "Flatten planes", toggle: true,
  help: "Fits a plane around each point (PCA) and moves the point along its beam onto it.",
  params: [
    { k: "wb", label: "Window along layer", min: 1, max: 12, step: 1, unit: " beams" },
    { k: "wl", label: "Window across layers", min: 0, max: 2, step: 1, unit: " layers" },
    { k: "planarity", label: "Max. curvature", min: 0.002, max: 0.2, step: 0.002, fmt: v => v.toFixed(3) },
    { k: "minPts", label: "Min. points in fit", min: 4, max: 40, step: 1 },
    { k: "minCos", label: "Min. incidence", min: 0, max: 0.6, step: 0.01, fmt: v => Math.round(Math.asin(v) / DEG) + "° to surface" },
    { k: "tolAbs", label: "Same-surface tolerance", min: 0.05, max: 0.5, step: 0.01, unit: " m" },
    { k: "tolRel", label: "Tolerance growth", min: 0, max: 0.1, step: 0.005, pct: true },
    { k: "noiseFlat", label: "Flat test", min: 0, max: 5, step: 0.25, fmt: v => v ? `residual ≤ ${v}× noise floor` : "curvature only", edit: { scale: 1, unit: "× noise floor (0 = curvature only)" } } ],
  defaults: { on: true, wb: 4, wl: 1, planarity: 0.02, minPts: 8, minCos: 0.15, tolAbs: 0.2, tolRel: 0.03, noiseFlat: 0 },
  auto: "tuned", preset: true,
};

/** area class: 0 static flat · 1 static detail · 2 moving */
export const planesState = beamState({ area: Uint8Array }, { reset: true });

/** each beam's point (range × ray) and confidence, once per scan instead of once per window it falls in */
let pts = new Float64Array(0);

export function flattenPlanes(g: Grid, src: Float32Array, dst: Float32Array, cfg: Config): void {
  const c = cfg.planes, { L, B, N, rayX, rayY, rayZ, area, motionHold, conf } = g, adaptive = cfg.adaptive.on;
  for (let i = 0; i < N; i++) area[i] = adaptive && motionHold[i] > 0 ? 2 : 1;      // isMoving
  if (!c.on) { dst.set(src); return; }
  if (pts.length < 4 * N) pts = new Float64Array(4 * N);
  const P = pts;
  for (let j = 0; j < N; j++) { const v = src[j]; P[4 * j] = rayX[j] * v; P[4 * j + 1] = rayY[j] * v; P[4 * j + 2] = rayZ[j] * v; P[4 * j + 3] = conf[j]; }
  const nrm = [0, 0, 0], wl = c.wl, wb = c.wb, minPts = c.minPts, tolAbs = c.tolAbs, tolRel = c.tolRel;
  for (let l = 0; l < L; l++) {
    const l0 = Math.max(0, l - wl), l1 = Math.min(L - 1, l + wl);
    for (let b = 0; b < B; b++) {
      const i = l * B + b, d = src[i];
      dst[i] = d;
      if (d <= 0 || area[i] === 2) continue;               // moving areas are not flattened
      const tol = sameTol(d, tolAbs, tolRel), b0 = Math.max(0, b - wb), b1 = Math.min(B - 1, b + wb);
      let n = 0, W = 0, sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, sxz = 0, syy = 0, syz = 0, szz = 0;
      for (let ll = l0; ll <= l1; ll++) {
        for (let j = ll * B + b0, je = ll * B + b1; j <= je; j++) {
          const v = src[j];
          if (v <= 0 || Math.abs(v - d) > tol) continue;
          const x = P[4 * j], y = P[4 * j + 1], z = P[4 * j + 2], w = P[4 * j + 3];   // confidence-weighted PCA
          n++; W += w; sx += w * x; sy += w * y; sz += w * z;
          sxx += w * x * x; sxy += w * x * y; sxz += w * x * z; syy += w * y * y; syz += w * y * z; szz += w * z * z;
        }
      }
      if (n < minPts || W <= 0) continue;
      const cx = sx / W, cy = sy / W, cz = sz / W;
      const variation = smallestEigenvector(sxx / W - cx * cx, sxy / W - cx * cy, sxz / W - cx * cz,
                                            syy / W - cy * cy, syz / W - cy * cz, szz / W - cz * cz, nrm);
      if (variation < 0) continue;
      if (c.noiseFlat > 0) {                               // flat = residual within the sensor noise
        const trace = (sxx + syy + szz) / W - (cx * cx + cy * cy + cz * cz);
        if (Math.sqrt(Math.max(0, variation * trace)) > c.noiseFlat * cfg.temporal.noiseFloor) continue;
      } else if (variation > c.planarity) continue;
      area[i] = 0;
      const nr = nrm[0] * rayX[i] + nrm[1] * rayY[i] + nrm[2] * rayZ[i];
      if (Math.abs(nr) < c.minCos) continue;               // grazing incidence: unstable
      const t = (nrm[0] * cx + nrm[1] * cy + nrm[2] * cz) / nr;   // ray–plane intersection
      if (t > 0 && Math.abs(t - d) <= tol) dst[i] = t;
    }
  }
}
