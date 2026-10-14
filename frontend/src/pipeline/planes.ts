// Plane flattening (local PCA plane fit, an MLS-style projection). For each point: gather same-surface
// neighbours in a window, fit a plane, and if the patch is planar enough move the point along its own
// laser ray onto that plane. Also classifies g.area (0 flat · 1 detail · 2 moving).
import type { Config } from "../config/config";
import { sameTol, smallestEigenvector } from "../core/math";
import type { Grid } from "./grid";
import { isMoving } from "./motion";

export function flattenPlanes(g: Grid, src: Float32Array, dst: Float32Array, cfg: Config): void {
  const c = cfg.planes, { L, B, rayX, rayY, rayZ, area } = g;
  for (let i = 0; i < g.N; i++) area[i] = isMoving(g, i, cfg) ? 2 : 1;
  if (!c.on) { dst.set(src); return; }
  const nrm = [0, 0, 0];
  for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
    const i = l * B + b, d = src[i];
    dst[i] = d;
    if (d <= 0 || area[i] === 2) continue;                 // moving areas are not flattened
    const tol = sameTol(d, c.tolAbs, c.tolRel);
    let n = 0, W = 0, sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, sxz = 0, syy = 0, syz = 0, szz = 0;
    for (let ll = Math.max(0, l - c.wl); ll <= Math.min(L - 1, l + c.wl); ll++) {
      for (let bb = Math.max(0, b - c.wb); bb <= Math.min(B - 1, b + c.wb); bb++) {
        const j = ll * B + bb, v = src[j];
        if (v <= 0 || Math.abs(v - d) > tol) continue;
        const x = rayX[j] * v, y = rayY[j] * v, z = rayZ[j] * v, w = g.conf[j];   // confidence-weighted PCA
        n++; W += w; sx += w * x; sy += w * y; sz += w * z;
        sxx += w * x * x; sxy += w * x * y; sxz += w * x * z; syy += w * y * y; syz += w * y * z; szz += w * z * z;
      }
    }
    if (n < c.minPts || W <= 0) continue;
    const cx = sx / W, cy = sy / W, cz = sz / W;
    const variation = smallestEigenvector(sxx / W - cx * cx, sxy / W - cx * cy, sxz / W - cx * cz,
                                          syy / W - cy * cy, syz / W - cy * cz, szz / W - cz * cz, nrm);
    if (variation < 0) continue;
    if (c.noiseFlat > 0) {                                 // flat = residual within the sensor noise
      const trace = (sxx + syy + szz) / W - (cx * cx + cy * cy + cz * cz);
      if (Math.sqrt(Math.max(0, variation * trace)) > c.noiseFlat * cfg.temporal.noiseFloor) continue;
    } else if (variation > c.planarity) continue;
    area[i] = 0;
    const nr = nrm[0] * rayX[i] + nrm[1] * rayY[i] + nrm[2] * rayZ[i];
    if (Math.abs(nr) < c.minCos) continue;                 // grazing incidence: unstable
    const t = (nrm[0] * cx + nrm[1] * cy + nrm[2] * cz) / nr;   // ray–plane intersection
    if (t > 0 && Math.abs(t - d) <= tol) dst[i] = t;
  }
}
