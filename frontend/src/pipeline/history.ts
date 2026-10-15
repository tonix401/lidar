// History filter + confidence. From the last 32 scans: valid ratio and jump rate. Beams that are rarely
// valid or keep jumping are dropped; the rest get a confidence weight that later stages multiply into
// their neighbour weights (stable, low-noise beams count more).
import type { Config } from "../config/config";
import type { StageDef } from "../config/types";
import { popcount } from "../core/math";
import { beamState } from "./beamState";
import type { Grid } from "./grid";
import { isMoving } from "./motion";

export type HistoryConfig = { on: boolean; minValid: number; maxJump: number; weight: number };

export const historyStage: StageDef<"history"> = {
  key: "history", title: "History filter", toggle: true,
  help: "Uses each beam's last 32 scans: drops beams that flicker (rarely valid or often jumping — mixed pixels " +
        "at edges, dust, reflections) and lets stable beams count more in spatial smoothing and plane fits.",
  params: [
    { k: "minValid", label: "Min. valid in history", min: 0, max: 1, step: 0.05, fmt: v => Math.round(v * 100) + " %", edit: { scale: 100, unit: "%" } },
    { k: "maxJump", label: "Max. jump rate", min: 0.05, max: 1, step: 0.05, fmt: v => Math.round(v * 100) + " %", edit: { scale: 100, unit: "%" } },
    { k: "weight", label: "Confidence weighting", min: 0, max: 3, step: 0.25, fmt: v => v ? "×" + v.toFixed(2) : "off", edit: { scale: 1, unit: "× (0 = off)" } } ],
  defaults: { on: true, minValid: 0.5, maxJump: 0.4, weight: 1 },
  auto: "tuned", preset: true, removed: { label: "Flicker", stat: "flicker" },
};

/** history-filtered ranges + confidence weights */
export const historyState = beamState({ hist: Float32Array, conf: Float32Array }, { reset: false });

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
