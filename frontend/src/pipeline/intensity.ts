import type { Config } from "../config/config";
import type { StageDef } from "../config/types";

export type IntensityConfig = { on: boolean; min: number; max: number };

export const intensityStage: StageDef<"intensity"> = {
  key: "intensity", title: "Intensity filter", toggle: true, extra: "histogram",
  help: "Drops returns whose RSSI lies outside the range, before any smoothing (weak returns are often noise; very strong ones are reflectors).",
  params: [
    { k: "min", label: "Min. RSSI", min: 0, max: 400, step: 1 },
    { k: "max", label: "Max. RSSI", min: 0, max: 400, step: 1 } ],
  defaults: { on: false, min: 0, max: 400 },
  auto: "user", preset: false, rawOff: true, removed: { label: "Intensity filter", stat: "intensity" },
};

/** RSSI histogram (8 units per bin, 50 bins) of the valid returns */
export function rssiHistogram(dist: Float32Array, rssi: Float32Array): Uint32Array {
  const hist = new Uint32Array(50);
  for (let i = 0; i < dist.length; i++) if (dist[i] > 0) hist[Math.min(49, rssi[i] >> 3)]++;
  return hist;
}

/** copy `src` into `dst`, dropping returns outside the RSSI window; returns how many were dropped */
export function intensityFilter(src: Float32Array, rssi: Float32Array, dst: Float32Array, c: Config["intensity"]): number {
  let removed = 0;
  for (let i = 0; i < src.length; i++) {
    const keep = src[i] > 0 && (!c.on || (rssi[i] >= c.min && rssi[i] <= c.max));
    if (src[i] > 0 && !keep) removed++;
    dst[i] = keep ? src[i] : 0;
  }
  return removed;
}
