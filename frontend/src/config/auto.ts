// Auto mode: settings derived from measured scene statistics. Rules from the literature:
//  • z-gate of 3 σ per beam (beam-wise statistical background subtraction for static LiDAR),
//  • tolerances scale with the measured noise floor and with range·tan(beam step) (range-adaptive radius),
//  • bilateral range σ follows each beam's own noise (noise-adaptive bilateral filtering),
//  • "flat" = plane residual within ~2 σ of the noise floor,
//  • motion: established model (≥5 scans), cluster filter, seeds grown into the object, short persistence
//    (Dynablox); cluster 8 / grow 12 / hold 1 s tuned on a recorded walk.
import type { Grid } from "../pipeline/grid";
import { DEFAULT_ADAPTIVE, DEFAULT_LAYERCAL, type Config } from "./config";

export function autoConfig(base: Config, noise: number): Config {
  const nf = noise, rel = 4 * Math.tan(0.13 * Math.PI / 180);      // ≈ 1 % of range per beam step
  return {
    ...structuredClone(base),
    outlier: { on: true, win: 2, need: 1, abs: Math.max(0.1, 5 * nf), rel: +rel.toFixed(3) },
    temporal: { on: true, window: 20, k: 3, minGate: Math.max(0.06, 2.5 * nf), confirm: 2, noiseFloor: nf, hold: 2 },
    history: { on: true, minValid: 0.5, maxJump: 0.3, weight: 1 },
    spatial: { on: true, wb: 3, wl: 0, srAbs: 1.5 * nf, srRel: 0.005, srNoise: 2 },
    dynamic: { on: true, radius: Math.max(0.04, 3 * nf), minPts: 4, gap: 0.3 },
    planes: { on: true, wb: 5, wl: 1, planarity: 0.02, minPts: 12, minCos: 0.2, tolAbs: Math.max(0.1, 5 * nf), tolRel: 0.02, noiseFlat: 2 },
    mesh: { jump: 0.3, jumpRel: 0.03 },
    outline: { on: base.outline.on, margin: Math.max(0.1, 4 * nf) },   // on/off stays the user's (USER_TOGGLES)
    adaptive: { ...DEFAULT_ADAPTIVE },
    layercal: { ...DEFAULT_LAYERCAL },
  };
}

export interface NoiseEstimate { noise: number; samples: number; movingShare: number }

/** noise floor = median σ of steady, established, static beams, quantised to 1 mm so settings don't
 *  jitter, clamped to 12..80 mm. null until enough beams are known. */
export function estimateNoise(g: Grid): NoiseEstimate | null {
  if (g.frames < 10) return null;
  const s: number[] = [];
  for (let i = 0; i < g.N; i += 3)
    if (g.nAvg[i] >= 5 && g.jumpRate[i] < 0.1 && g.motionHold[i] === 0 && g.temporal[i] > 0) s.push(Math.sqrt(g.noiseVar[i]));
  if (s.length <= 200) return null;
  s.sort((a, b) => a - b);
  let moving = 0;
  for (let i = 0; i < g.N; i++) if (g.motionHold[i] > 0) moving++;
  return { noise: Math.min(0.08, Math.max(0.012, Math.round(s[s.length >> 1] * 1000) / 1000)), samples: s.length,
           movingShare: moving / g.N };
}
