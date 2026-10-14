// Adaptive: motion detection (before the temporal update). Follows per-beam background subtraction for
// static LiDARs (beam-wise statistical models with a z-gate |r−μ|/σ ≤ k, multi-modal backgrounds) and
// Dynablox's conservative rules:
//  • a beam only reports change once its model is established (≥ 5 of the last scans valid),
//  • a return matching either of the beam's two background modes is NOT a change,
//  • changed beams are grouped into connected clusters (8-neighbourhood, similar range); clusters
//    smaller than `minCluster` beams are noise and dropped,
//  • surviving clusters seed a region grow through neighbouring beams of similar range (the rest of the
//    object), limited to `growBeams` steps and never into beams that match their own established
//    background (so it can't leak along a wall); grown beams stay "moving" for `hold` scans.
import type { Config } from "../config/config";
import { popcount } from "../core/math";
import type { Grid } from "./grid";

export const ESTABLISHED = 5;

/** change gate of beam i: k·σ of this beam (σ incl. the uncertainty of its mean), at least minGate */
export function beamGate(g: Grid, i: number, ct: Config["temporal"]): number {
  const s = Math.sqrt(g.noiseVar[i] * (1 + 1 / Math.max(1, g.nAvg[i])));
  return Math.max(ct.minGate, ct.k * s);
}

/** does range z match beam i's established background (either mode)? */
export function isBackground(g: Grid, i: number, z: number, ct: Config["temporal"]): boolean {
  if (g.nAvg[i] < ESTABLISHED && g.altN[i] < ESTABLISHED) return false;
  const gate = beamGate(g, i, ct);
  return (g.nAvg[i] >= ESTABLISHED && Math.abs(z - g.temporal[i]) <= gate) || (g.altN[i] >= ESTABLISHED && Math.abs(z - g.alt[i]) <= gate);
}

export const isMoving = (g: Grid, i: number, cfg: Config): boolean => cfg.adaptive.on && g.motionHold[i] > 0;

/** marks g.changed / g.motionHold for this scan; returns the number of moving clusters */
export function detectMotion(g: Grid, cur: Float32Array, cfg: Config): number {
  const a = cfg.adaptive, ct = cfg.temporal, { L, B, N, temporal: T, alt, altN, changed, motionHold, validBits } = g;
  for (let i = 0; i < N; i++) if (motionHold[i] > 0) motionHold[i]--;
  changed.fill(0);
  if (!a.on || g.frames < ESTABLISHED) return 0;
  for (let i = 0; i < N; i++) {
    const z = cur[i];
    if (z <= 0 || popcount(validBits[i] & 0x3f) < ESTABLISHED) continue;
    const gate = beamGate(g, i, ct);
    const matchT = T[i] > 0 && Math.abs(z - T[i]) <= gate, matchAlt = alt[i] > 0 && altN[i] >= 3 && Math.abs(z - alt[i]) <= gate;
    if (!matchT && !matchAlt) changed[i] = 1;
  }
  const Q = g.queue, mark = g.mark;
  mark.fill(0);
  const same = (p: number, q: number) => Math.abs(cur[p] - cur[q]) <= 0.15 + 0.03 * cur[p];
  let seeds = 0;
  for (let s0 = 0; s0 < N; s0++) {
    if (!changed[s0] || mark[s0]) continue;
    let head = 0, tail = 0;                                  // 1) connected cluster of changed beams
    Q[tail++] = s0; mark[s0] = 1;
    while (head < tail) {
      const p = Q[head++], l = (p / B) | 0, b = p - l * B;
      for (let dl = -1; dl <= 1; dl++) for (let db = -1; db <= 1; db++) {
        const ll = l + dl, bb = b + db;
        if (ll < 0 || ll >= L || bb < 0 || bb >= B) continue;
        const q = ll * B + bb;
        if (changed[q] && !mark[q] && same(p, q)) { mark[q] = 1; Q[tail++] = q; }
      }
    }
    if (tail < a.minCluster) continue;                       // too small: noise
    seeds++;
    let ringStart = 0, ringEnd = tail;                       // 2) grow into the rest of the object
    for (let k = 0; k < tail; k++) motionHold[Q[k]] = a.hold;
    for (let depth = 0; depth < a.growBeams && ringStart < ringEnd; depth++) {
      for (let h = ringStart; h < ringEnd; h++) {
        const p = Q[h], l = (p / B) | 0, b = p - l * B;
        for (let dl = -1; dl <= 1; dl++) for (let db = -1; db <= 1; db++) {
          const ll = l + dl, bb = b + db;
          if (ll < 0 || ll >= L || bb < 0 || bb >= B) continue;
          const q = ll * B + bb;
          if (mark[q] || cur[q] <= 0 || !same(p, q) || isBackground(g, q, cur[q], ct)) continue;
          mark[q] = 2; Q[tail++] = q; motionHold[q] = a.hold;
        }
      }
      ringStart = ringEnd; ringEnd = tail;
    }
  }
  return seeds;
}
