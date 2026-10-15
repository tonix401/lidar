// Spatial smoothing: bilateral filter on the range image. Weighted mean of neighbouring ranges, weight
// falls off with pixel distance and with range difference, so surfaces are smoothed but depth edges kept.
import type { Config } from "../config/config";
import type { StageDef } from "../config/types";
import { sameTol } from "../core/math";
import type { Grid } from "./grid";
import { isMoving } from "./motion";

export type SpatialConfig = { on: boolean; wb: number; wl: number; srAbs: number; srRel: number; srNoise: number };

export const spatialStage: StageDef<"spatial"> = {
  key: "spatial", title: "Spatial smoothing", toggle: true,
  help: "Edge-preserving bilateral filter on the range image.",
  params: [
    { k: "wb", label: "Window along layer", min: 1, max: 12, step: 1, unit: " beams" },
    { k: "wl", label: "Window across layers", min: 0, max: 2, step: 1, unit: " layers" },
    { k: "srAbs", label: "Edge sensitivity σ", min: 0.01, max: 0.3, step: 0.005, unit: " m" },
    { k: "srRel", label: "σ growth", min: 0, max: 0.05, step: 0.001, pct: true },
    { k: "srNoise", label: "σ from beam noise", min: 0, max: 5, step: 0.5, fmt: v => v ? `≥ ${v}× beam σ` : "off", edit: { scale: 1, unit: "× beam σ (0 = off)" } } ],
  defaults: { on: true, wb: 3, wl: 0, srAbs: 0.05, srRel: 0.01, srNoise: 0 },
  auto: "tuned", preset: true,
};

export function bilateral(g: Grid, src: Float32Array, dst: Float32Array, cfg: Config): void {
  const c = cfg.spatial, { L, B } = g;
  if (!c.on) { dst.set(src); return; }
  const sb = Math.max(1, c.wb / 2), sl = 1;
  for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
    const i = l * B + b, d = src[i];
    if (d <= 0) { dst[i] = 0; continue; }
    const moving = isMoving(g, i, cfg);
    if (moving && cfg.dynamic.on) { dst[i] = d; continue; }          // smoothed in 3D by dynSmooth instead
    const wb = moving ? Math.min(c.wb, cfg.adaptive.dynSpatial) : c.wb, wl = moving ? 0 : c.wl;
    if (wb === 0 && wl === 0) { dst[i] = d; continue; }
    const sr = Math.max(sameTol(d, c.srAbs, c.srRel), c.srNoise * Math.sqrt(g.noiseVar[i])), cut = 3 * sr;
    let ws = 0, acc = 0;
    for (let dl = -wl; dl <= wl; dl++) {
      const ll = l + dl;
      if (ll < 0 || ll >= L) continue;
      for (let db = -wb; db <= wb; db++) {
        const bb = b + db;
        if (bb < 0 || bb >= B) continue;
        const j = ll * B + bb, v = src[j];
        if (v <= 0 || Math.abs(v - d) > cut) continue;
        const w = g.conf[j] * Math.exp(-(db * db) / (2 * sb * sb) - (dl * dl) / (2 * sl * sl) - ((v - d) * (v - d)) / (2 * sr * sr));
        ws += w; acc += w * v;
      }
    }
    dst[i] = ws > 0 ? acc / ws : d;
  }
}
