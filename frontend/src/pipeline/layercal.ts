// Layer calibration: per-layer distance offsets (m), added to every raw distance of that layer before
// filtering. Learned from leave-own-layer-out plane fits on the (temporally averaged, already corrected)
// range image: for points on flat surfaces, fit a plane through the neighbouring layers only (±2 layers,
// ±6 beams) and measure along the beam how far this layer's point is from it. The median per layer is its
// remaining offset; the offset moves a fraction `rate` towards it.
import type { StageDef } from "../config/types";
import { smallestEigenvector } from "../core/math";
import type { Grid } from "./grid";

export type LayercalConfig = { on: boolean; rate: number };

export const layercalStage: StageDef<"layercal"> = {
  key: "layercal", title: "Layer calibration", toggle: true, extra: "layerbias",
  help: "Each of the 24 layers has its own constant distance offset (up to a few cm), which shows up as horizontal " +
        "waves on flat walls. The offsets are learned live: each layer's median deviation from planes fitted through " +
        "its neighbouring layers. Mean, bottom-to-top trend and slow bow are pinned to zero (unmeasurable " +
        "from plane fits, they would otherwise drift into tilted or bulging walls), so scale and verticality are untouched.",
  params: [
    { k: "rate", label: "Learning rate", min: 0, max: 1, step: 0.05, fmt: v => v ? Math.round(v * 100) + " % per update" : "frozen", edit: { scale: 100, unit: "% per update" } } ],
  defaults: { on: true, rate: 0.3 },
  auto: "tuned", preset: false, rawOff: true,
};

export function applyLayerBias(g: Grid, ranges: Float32Array, bias: Float32Array): void {
  for (let l = 0; l < g.L; l++) {
    const off = bias[l] ?? 0;
    for (let i = l * g.B; i < (l + 1) * g.B; i++) if (ranges[i] > 0) ranges[i] += off;
  }
}

/** one learning step; returns false when too few flat surfaces are in view */
export function updateLayerBias(g: Grid, D: Float32Array, bias: Float32Array, rate: number): boolean {
  const { L, B, rayX, rayY, rayZ } = g, nrm = [0, 0, 0];
  const per: number[][] = Array.from({ length: L }, () => []);
  for (let l = 0; l < L; l++) for (let b = 6; b < B - 6; b += 2) {
    const i = l * B + b, d = D[i];
    if (d <= 0) continue;
    const tol = 0.15 + 0.03 * d;
    let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, sxz = 0, syy = 0, syz = 0, szz = 0;
    for (let ll = Math.max(0, l - 2); ll <= Math.min(L - 1, l + 2); ll++) {
      if (ll === l) continue;
      for (let bb = b - 6; bb <= b + 6; bb++) {
        const j = ll * B + bb, v = D[j];
        if (v <= 0 || Math.abs(v - d) > tol) continue;
        const x = rayX[j] * v, y = rayY[j] * v, z = rayZ[j] * v;
        n++; sx += x; sy += y; sz += z; sxx += x * x; sxy += x * y; sxz += x * z; syy += y * y; syz += y * z; szz += z * z;
      }
    }
    if (n < 20) continue;
    const cx = sx / n, cy = sy / n, cz = sz / n;
    const v = smallestEigenvector(sxx / n - cx * cx, sxy / n - cx * cy, sxz / n - cx * cz, syy / n - cy * cy, syz / n - cy * cz, szz / n - cz * cz, nrm);
    if (v < 0 || v > 0.03) continue;                                  // only flat patches
    const nr = nrm[0] * rayX[i] + nrm[1] * rayY[i] + nrm[2] * rayZ[i];
    if (Math.abs(nr) < 0.3) continue;                                  // not too grazing
    const r = (nrm[0] * cx + nrm[1] * cy + nrm[2] * cz) / nr - d;
    if (Math.abs(r) < 0.1) per[l].push(r);
  }
  const upd = per.map(a => { if (a.length < 20) return null; a.sort((x, y) => x - y); return a[a.length >> 1]; });
  const known = upd.filter((x): x is number => x !== null);
  if (known.length < L / 2) return false;
  const mean = known.reduce((a, x) => a + x, 0) / known.length;
  for (let l = 0; l < L; l++) { const u = upd[l]; if (u !== null) bias[l] += rate * (u - mean); }
  removeUnobservable(bias);
  return true;
}

/** Plane fits through neighbouring layers cannot see a constant offset (it only moves everything) or an
 *  offset growing linearly from bottom to top (it only tilts every surface, and the neighbour planes tilt
 *  with it), and barely see a slow bow. Left free these drift: vertical walls leaned 15°+ after ~10 min,
 *  the bow settled at ~8 cm. So offsets are kept orthogonal to all polynomials up to degree 2 in the
 *  layer index — the real per-layer pattern (period ≈ 6 layers) is untouched. */
export function removeUnobservable(b: Float32Array): void {
  const L = b.length, basis: Float64Array[] = [];
  for (let deg = 0; deg <= 2; deg++) {                    // Gram–Schmidt on 1, l, l²
    const v = Float64Array.from({ length: L }, (_, l) => ((l - (L - 1) / 2) / L) ** deg);
    for (const u of basis) { let d = 0; for (let l = 0; l < L; l++) d += v[l] * u[l]; for (let l = 0; l < L; l++) v[l] -= d * u[l]; }
    let n = 0; for (let l = 0; l < L; l++) n += v[l] * v[l]; n = Math.sqrt(n);
    if (n < 1e-12) continue;
    for (let l = 0; l < L; l++) v[l] /= n;
    basis.push(v);
  }
  for (const u of basis) { let d = 0; for (let l = 0; l < L; l++) d += b[l] * u[l]; for (let l = 0; l < L; l++) b[l] -= d * u[l]; }
}
