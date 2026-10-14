// Quality metrics for moving areas (people), to compare settings on the same recording:
//  • roughness: median |range − mean of same-surface 3×3 neighbours| over moving beams (spatial wobble),
//  • flicker: share of moving beams whose foreground state (in front of the object detector's empty-scene
//    background) flipped since the previous scan (outline jumping between person and wall).
import type { Config } from "../config/config";
import { median } from "../core/math";
import { foreground, type Background } from "../objects/background";
import type { Grid } from "./grid";
import { isMoving } from "./motion";

export const SAME_ABS = 0.15, SAME_REL = 0.03;    // same surface, as in motion detection

/** median roughness of moving beams in mm (NaN without moving beams) */
export function movingRoughness(g: Grid, D: Float32Array, cfg: Config): number {
  const { L, B } = g, res: number[] = [];
  for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
    const i = l * B + b, d = D[i];
    if (d <= 0 || !isMoving(g, i, cfg)) continue;
    const tol = SAME_ABS + SAME_REL * d;
    let n = 0, s = 0;
    for (let ll = Math.max(0, l - 1); ll <= Math.min(L - 1, l + 1); ll++)
      for (let bb = Math.max(0, b - 1); bb <= Math.min(B - 1, b + 1); bb++) {
        const j = ll * B + bb, v = D[j];
        if (j === i || v <= 0 || Math.abs(v - d) > tol) continue;
        n++; s += v;
      }
    if (n >= 2) res.push(Math.abs(d - s / n));
  }
  return median(res) * 1000;
}

/** foreground flips of moving beams between consecutive scans */
export class FlickerMeter {
  private prev: Uint8Array;
  private cur: Uint8Array;
  private valid = false;

  constructor(N: number) { this.prev = new Uint8Array(N); this.cur = new Uint8Array(N); }

  reset(): void { this.valid = false; }

  /** share of moving beams (0..1) whose foreground state changed; NaN until two scans with a background */
  update(g: Grid, D: Float32Array, bg: Background | null, cfg: Config): number {
    if (!bg?.ready) { this.valid = false; return NaN; }
    foreground(bg, D, g.noiseVar, g.area, cfg.objects, this.cur);
    let moving = 0, flips = 0;
    if (this.valid) for (let i = 0; i < g.N; i++) {
      if (!isMoving(g, i, cfg)) continue;
      moving++;
      if (this.cur[i] !== this.prev[i]) flips++;
    }
    [this.prev, this.cur] = [this.cur, this.prev];
    const had = this.valid;
    this.valid = true;
    return had && moving ? flips / moving : NaN;
  }
}
