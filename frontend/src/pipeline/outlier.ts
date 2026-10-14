// Outlier rejection on the raw scan: a return survives if enough azimuth neighbours in its layer lie at
// a similar distance — isolated spikes and mixed pixels go, object edges (supported on one side) stay.
import type { Config } from "../config/config";
import { sameTol } from "../core/math";
import type { Grid } from "./grid";
import { isMoving } from "./motion";

export function rejectOutliers(g: Grid, src: Float32Array, dst: Float32Array, cfg: Config): number {
  const { L, B } = g, c = cfg.outlier;
  let removed = 0;
  for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
    const i = l * B + b, d = src[i];
    dst[i] = d;
    if (!c.on || d <= 0) continue;
    // moving bodies have real depth jumps between neighbouring beams (limbs, silhouettes):
    // there one similar neighbour within a 3× wider tolerance is enough
    const moving = isMoving(g, i, cfg) || (cfg.adaptive.on && g.changed[i] === 1);
    const tol = sameTol(d, c.abs, c.rel) * (moving ? 3 : 1), need = moving ? 1 : c.need;
    let support = 0;
    for (let k = Math.max(0, b - c.win); k <= Math.min(B - 1, b + c.win); k++)
      if (k !== b && src[l * B + k] > 0 && Math.abs(src[l * B + k] - d) <= tol) support++;
    if (support < need) { dst[i] = 0; removed++; }
  }
  return removed;
}
