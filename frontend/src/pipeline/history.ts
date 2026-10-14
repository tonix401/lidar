// History filter + confidence. From the last 32 scans: valid ratio and jump rate. Beams that are rarely
// valid or keep jumping are dropped; the rest get a confidence weight that later stages multiply into
// their neighbour weights (stable, low-noise beams count more).
import type { Config } from "../config/config";
import { popcount } from "../core/math";
import type { Grid } from "./grid";
import { isMoving } from "./motion";

export const historyMask = (frames: number): number => frames >= 32 ? 0xffffffff : ((1 << frames) - 1) >>> 0;

export function historyFilter(g: Grid, src: Float32Array, dst: Float32Array, cfg: Config): number {
  const c = cfg.history, { N, validBits, jumpRate, noiseVar, conf } = g;
  const mask = historyMask(g.frames), floor2 = cfg.temporal.noiseFloor ** 2;
  let dropped = 0;
  for (let i = 0; i < N; i++) {
    const d = src[i];
    dst[i] = d; conf[i] = 1;
    if (d <= 0 || !c.on || isMoving(g, i, cfg)) continue;   // moving objects flicker by nature: keep them
    const valid = popcount(validBits[i] & mask) / Math.max(1, g.frames);
    if (valid < c.minValid || jumpRate[i] > c.maxJump) { dst[i] = 0; dropped++; continue; }
    if (c.weight > 0) {
      const quality = valid * (1 - jumpRate[i]) * floor2 / Math.max(floor2, noiseVar[i]);   // 1 = always valid, steady, at the noise floor
      conf[i] = Math.pow(Math.max(1e-3, quality), c.weight);
    }
  }
  return dropped;
}
