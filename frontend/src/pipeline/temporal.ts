// Temporal smoothing (per-beam history, Kalman-style). Each beam keeps a running mean whose window grows
// while the beam stays still (up to `window` scans), i.e. a 1D Kalman filter for a constant distance.
// Every beam also learns its own measurement noise σ (EMA of squared innovations, never below
// `noiseFloor`), so the change gate is k·σ of *this* beam. A sample outside the gate does not reset the
// beam at once: it becomes a candidate, and only when `confirm` consecutive samples agree does the beam
// switch (real motion). Lone spikes are ignored. The old surface is kept as a second background mode.
import type { Config } from "../config/config";
import type { StageDef } from "../config/types";
import { beamState } from "./beamState";
import type { Grid } from "./grid";
import { beamGate, isMoving } from "./motion";

export type TemporalConfig = { on: boolean; window: number; k: number; minGate: number; confirm: number; noiseFloor: number; hold: number };

export const temporalStage: StageDef<"temporal"> = {
  key: "temporal", title: "Temporal smoothing", toggle: true, note: "Applies to new scans.",
  help: "Each beam averages its own history (Kalman-style): the window grows while the beam is still, " +
        "its noise σ is learned, a change beyond k·σ must be confirmed by following scans before the beam " +
        "switches (single spikes are ignored, real motion is followed).",
  params: [
    { k: "window", label: "Max. averaging window", min: 1, max: 60, step: 1, unit: " scans" },
    { k: "k", label: "Change gate", min: 1.5, max: 8, step: 0.5, fmt: v => v.toFixed(1) + " σ", edit: { scale: 1, unit: "σ" } },
    { k: "minGate", label: "Min. gate", min: 0.03, max: 0.5, step: 0.01, unit: " m" },
    { k: "confirm", label: "Confirm change after", min: 1, max: 5, step: 1, unit: " scans" },
    { k: "noiseFloor", label: "Noise floor σ", min: 0.005, max: 0.1, step: 0.001, fmt: v => Math.round(v * 1000) + " mm", edit: { scale: 1000, unit: "mm" } },
    { k: "hold", label: "Hold through dropouts", min: 0, max: 10, step: 1, unit: " scans" } ],
  defaults: { on: true, window: 10, k: 3, minGate: 0.1, confirm: 2, noiseFloor: 0.02, hold: 2 },
  auto: "tuned", preset: true,
};

/** the temporal model per beam: estimate, samples in the average, learned noise variance, pending change
 *  candidate, dropout age, validity bits of the last 32 scans, jump rate, second background mode */
export const temporalState = beamState({
  temporal: Float32Array, nAvg: Uint16Array, noiseVar: Float32Array, cand: Float32Array, candCnt: Uint8Array, age: Uint8Array,
  validBits: Uint32Array, jumpRate: Float32Array, alt: Float32Array, altN: Uint16Array,
}, { reset: true });

export const NOISE_BETA = 0.05, JUMP_BETA = 0.1;

export function temporalUpdate(g: Grid, cur: Float32Array, cfg: Config): void {
  const c = cfg.temporal, on = c.on, hold = on ? c.hold : 0, staticN = on ? c.window : 1;
  const dynN = Math.min(staticN, cfg.adaptive.dynWindow);
  const floor2 = c.noiseFloor * c.noiseFloor;
  const { temporal: T, nAvg, noiseVar: R, cand, candCnt, age, validBits, jumpRate, alt, altN } = g;
  for (let i = 0; i < g.N; i++) {
    const z = cur[i];
    validBits[i] = ((validBits[i] << 1) | (z > 0 ? 1 : 0)) >>> 0;
    if (z <= 0) {                                         // dropout: hold, then forget
      if (age[i] < 255) age[i]++;
      if (age[i] > hold) { T[i] = 0; nAvg[i] = 0; candCnt[i] = 0; }
      continue;
    }
    age[i] = 0;
    const moving = isMoving(g, i, cfg), maxN = moving ? dynN : staticN, confirm = moving ? 1 : c.confirm;
    if (moving && nAvg[i] > maxN) nAvg[i] = maxN;          // forget the long average at once
    if (T[i] <= 0 || nAvg[i] === 0) {                     // first sample of this beam
      T[i] = z; nAvg[i] = 1; R[i] = Math.max(R[i], floor2); candCnt[i] = 0;
      continue;
    }
    const gate = beamGate(g, i, c);
    // came back to the second background mode → swap instantly (no confirmation, not a jump)
    if (on && alt[i] > 0 && altN[i] >= 2 && Math.abs(z - T[i]) > gate && Math.abs(z - alt[i]) <= gate) {
      const t = T[i], n = nAvg[i];
      T[i] = alt[i]; nAvg[i] = Math.min(altN[i], maxN); alt[i] = t; altN[i] = n;
    }
    const v = z - T[i];
    if (Math.abs(v) <= gate) {                            // consistent: extend the average
      const n = Math.min(nAvg[i] + 1, maxN);
      nAvg[i] = n;
      T[i] += v / n;
      R[i] = Math.max(floor2, R[i] + NOISE_BETA * (v * v - R[i]));
      jumpRate[i] *= 1 - JUMP_BETA;
      candCnt[i] = 0;
    } else {                                              // unknown value: candidate for a change
      jumpRate[i] += JUMP_BETA * (1 - jumpRate[i]);
      if (candCnt[i] > 0 && Math.abs(z - cand[i]) <= gate) {
        candCnt[i]++; cand[i] += (z - cand[i]) / candCnt[i];
      } else { cand[i] = z; candCnt[i] = 1; }
      if (!on || candCnt[i] >= confirm) {                 // confirmed → follow; old surface becomes the 2nd mode
        if (nAvg[i] >= 3) { alt[i] = T[i]; altN[i] = nAvg[i]; }
        T[i] = cand[i]; nAvg[i] = candCnt[i]; candCnt[i] = 0;
      }
    }
  }
}
