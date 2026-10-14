// Spatial smoothing: bilateral filter on the range image. Weighted mean of neighbouring ranges, weight
// falls off with pixel distance and with range difference, so surfaces are smoothed but depth edges kept.
import type { Config } from "../config/config";
import { sameTol } from "../core/math";
import type { Grid } from "./grid";
import { isMoving } from "./motion";

export function bilateral(g: Grid, src: Float32Array, dst: Float32Array, cfg: Config): void {
  const c = cfg.spatial, { L, B } = g;
  if (!c.on) { dst.set(src); return; }
  const sb = Math.max(1, c.wb / 2), sl = 1;
  for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
    const i = l * B + b, d = src[i];
    if (d <= 0) { dst[i] = 0; continue; }
    const moving = isMoving(g, i, cfg), wb = moving ? Math.min(c.wb, cfg.adaptive.dynSpatial) : c.wb, wl = moving ? 0 : c.wl;
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
