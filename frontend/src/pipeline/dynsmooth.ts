// Moving-area smoothing: 3D smoothing within one scan for moving beams (people), which the per-beam
// stages pass through almost raw (a beam can't follow a moving body). For each moving beam: the weighted
// mean of the 3D points around it — the window covers `radius` metres at the beam's range; weights are
// Gaussians on the true 3D offset, split into its part across the beam (σ = radius/2) and along it
// (σ = 2× the beam's range noise: the beams are far closer together than the range noise, so one
// isotropic Gaussian would mostly weigh noise), times the history confidence — projected back onto the
// beam's own ray, so the grid stays organized. Only moving neighbours or ones in front of the empty-scene background
// count: a person never blends into the wall behind.
// Veils: a moving beam on a depth jump of more than `gap` between its two opposite neighbours (along the
// layer or across layers) that matches neither side and lies clearly in front of its own background is a
// mixed pixel between person and what is behind, and is dropped. (A beam merely behind a nearer one, e.g.
// the torso next to an arm, matches its far side and stays.)
import type { Config } from "../config/config";
import type { StageDef } from "../config/types";
import { DEG } from "../core/math";
import { fgTol } from "../objects/background";
import type { Grid } from "./grid";
import { ESTABLISHED, isMoving } from "./motion";

export type DynamicConfig = { on: boolean; radius: number; minPts: number; gap: number };

export const dynamicStage: StageDef<"dynamic"> = {
  key: "dynamic", title: "Moving-area smoothing", toggle: true, note: "Needs 'Adaptive per area'; replaces its 'Spatial window in moving areas'.",
  help: "3D smoothing within one scan for moving areas (people), which the other stages pass through almost raw: " +
        "each moving point becomes the weighted mean of the 3D points within the radius around it (moving or in front " +
        "of the empty scene only, never the wall behind), moved back onto its own beam. Points hanging between a " +
        "person and the wall behind (mixed pixels at the outline) are dropped.",
  params: [
    { k: "radius", label: "Radius", min: 0.02, max: 0.3, step: 0.01, unit: " m" },
    { k: "minPts", label: "Min. points", min: 1, max: 30, step: 1 },
    { k: "gap", label: "Drop mixed pixels behind by", min: 0.1, max: 1, step: 0.05, unit: " m" } ],
  defaults: { on: true, radius: 0.08, minPts: 4, gap: 0.3 },
  auto: "tuned", preset: true, removed: { label: "Mixed pixels", stat: "veils" },
};

export const MAX_WB = 12, MAX_WL = 2;

/** empty-scene range of beam i: the object detector's background, else the beam's second mode (0 = unknown) */
const backgroundOf = (g: Grid, bg: Float32Array | null, i: number): number =>
  bg ? bg[i] : g.altN[i] >= ESTABLISHED ? g.alt[i] : 0;

/** smooths moving beams of `src` into `dst` (other beams untouched); returns the number of veil beams dropped */
export function dynSmooth(g: Grid, src: Float32Array, dst: Float32Array, bg: Float32Array | null, stepDeg: number,
                          cfg: Config): number {
  const c = cfg.dynamic, { L, B, rayX, rayY, rayZ, elev, conf, noiseVar } = g;
  if (!c.on || !cfg.adaptive.on) return 0;
  const stepRad = Math.max(1e-4, Math.abs(stepDeg) * DEG);
  const layerStepRad = L > 1 ? Math.max(1e-4, Math.abs(elev[B] - elev[0]) * DEG) : 1;
  const sLat = 2 * (c.radius / 2) ** 2, cutLat = c.radius ** 2, floor = cfg.temporal.noiseFloor;
  const front = (j: number, v: number) => { const b = backgroundOf(g, bg, j); return b > 0 && v < b - fgTol(cfg.objects, noiseVar[j], b); };
  let veils = 0;
  for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
    const i = l * B + b, d = src[i];
    if (d <= 0 || !isMoving(g, i, cfg)) continue;
    const sR = 2 * Math.max(floor, Math.sqrt(noiseVar[i])), sAlong = 2 * sR * sR, cutAlong = Math.min(c.gap, 3 * sR);
    const between = (p: number, q: number) => {
      const u = src[p], v = src[q], near = Math.min(u, v), far = Math.max(u, v);
      return u > 0 && v > 0 && far - near > c.gap && d - near > cutAlong && far - d > cutAlong;
    };
    if (((b > 0 && b < B - 1 && between(i - 1, i + 1)) || (l > 0 && l < L - 1 && between(i - B, i + B))) && front(i, d)) {
      dst[i] = 0; veils++; continue;
    }

    const wb = Math.min(MAX_WB, Math.max(1, Math.ceil(c.radius / (d * stepRad))));
    const wl = Math.min(MAX_WL, Math.max(0, Math.ceil(c.radius / (d * layerStepRad))));
    const ux = rayX[i], uy = rayY[i], uz = rayZ[i], px = ux * d, py = uy * d, pz = uz * d;
    let n = 0, ws = 0, sx = 0, sy = 0, sz = 0;
    for (let ll = Math.max(0, l - wl); ll <= Math.min(L - 1, l + wl); ll++)
      for (let bb = Math.max(0, b - wb); bb <= Math.min(B - 1, b + wb); bb++) {
        const j = ll * B + bb, v = src[j];
        if (v <= 0 || (j !== i && !isMoving(g, j, cfg) && !front(j, v))) continue;
        const x = rayX[j] * v, y = rayY[j] * v, z = rayZ[j] * v, dx = x - px, dy = y - py, dz = z - pz;
        const along = dx * ux + dy * uy + dz * uz, lat2 = dx * dx + dy * dy + dz * dz - along * along;
        if (lat2 > cutLat || Math.abs(along) > cutAlong) continue;
        const w = conf[j] * Math.exp(-lat2 / sLat - along * along / sAlong);
        n++; ws += w; sx += w * x; sy += w * y; sz += w * z;
      }
    if (n < c.minPts || ws <= 0) { dst[i] = d; continue; }
    const t = (sx * ux + sy * uy + sz * uz) / ws;      // mean point, projected onto the ray
    dst[i] = t > 0 ? t : d;
  }
  return veils;
}
