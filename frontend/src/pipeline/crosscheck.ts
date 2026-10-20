// Cross-check with the other sensors (several sensors only): a return another sensor has seen through is not
// a surface. Mixed pixels (an echo between a person's outline and the wall behind), dust and other ghosts float
// in space that a sensor looking from elsewhere sees as empty: its beams around that point all return clearly
// farther away. It runs twice: on the new scan like the outlier filter, so the temporal model, the background
// and the object detector never see such returns; and on the final output, where it catches what the
// per-beam smoothing still shows although it is gone — a range held through a dropout, or a person the
// temporal model has not let go of yet. Each output value is judged on its own: a beam dropped from the scan
// usually holds the right surface (the wall behind a mixed pixel), and that stays.
// Conservative by construction: "no return" is never evidence (dark surfaces), and every beam of the other
// sensor around the point must pass behind it — the two layers bracketing it in elevation (on a floor seen at
// a grazing angle the lower one lands in front), ±1 beam beside it. On a moving object (motion detection) the
// other sensor's scan is up to a scan older, and the object has moved since, sideways too: its beams would
// pass beside the object's real edge and "see through" it. There the window widens by the angle the object can
// have moved (allowed speed × age) and the margin in depth by that distance.
import type { Config } from "../config/config";
import type { StageDef } from "../config/types";
import { DEG } from "../core/math";
import { beamState } from "./beamState";
import type { Grid } from "./grid";

export type CrosscheckConfig = { on: boolean; margin: number; rel: number; speed: number };

export const crosscheckStage: StageDef<"crosscheck"> = {
  key: "crosscheck", title: "Cross-check with other sensors", toggle: true, note: "Several sensors only.",
  help: "Drops returns that another sensor sees through: its beams around the point all return clearly farther " +
        "away, so the point is in empty space (mixed pixels at outlines, dust, ghosts). No return never counts.",
  params: [
    { k: "margin", label: "Seen behind by at least", min: 0.05, max: 1, step: 0.01, unit: " m" },
    { k: "rel", label: "Margin growth", min: 0, max: 0.1, step: 0.005, pct: true },
    { k: "speed", label: "Allowed motion", min: 0, max: 5, step: 0.1, unit: " m/s", fmt: v => `${v.toFixed(1)} m/s × scan age` } ],
  defaults: { on: true, margin: 0.15, rel: 0.01, speed: 2 },
  auto: "user", preset: false, rawOff: true, removed: { label: "Seen through by another sensor", stat: "seenThrough" },
};

/** another sensor, as this one's cross-check needs it */
export interface OtherSensor {
  R: number[]; t: number[];          // a point in this sensor's frame → that sensor's frame (R 3×3 row-major)
  L: number; B: number;
  az0: number; step: number;         // degrees: azimuth of its first beam, beam step
  layerSin: Float32Array;            // sin(elevation) of each of its layers (mount applied)
  range: Float32Array;               // its latest ranges (m, 0 = no return)
  age: number;                       // s between its scan and this one
}

/** 1 = dropped this scan: another sensor saw through it */
export const crosscheckState = beamState({ seenThrough: Uint8Array }, { reset: false });

/** drop (zero) the returns in `r` that another sensor sees through; returns how many. `fresh`: a new pass over
 *  the scan (the mask restarts); otherwise it adds to this scan's mask. */
export function crossCheck(g: Grid, r: Float32Array, others: readonly OtherSensor[], cfg: Config, fresh = true): number {
  if (fresh) g.seenThrough.fill(0);
  const c = cfg.crosscheck;
  if (!c.on || !others.length) return 0;
  let removed = 0;
  const { N, rayX, rayY, rayZ, motionHold, seenThrough } = g, adaptive = cfg.adaptive.on;
  for (const o of others) {
    const { R, t, L, B, layerSin, range } = o, moved = c.speed * Math.abs(o.age);
    const up = layerSin[L - 1] > layerSin[0];                   // layers ordered by elevation (mount flips it)
    const layerStep = Math.abs(Math.asin(layerSin[L - 1]) - Math.asin(layerSin[0])) / (L - 1), beamStep = o.step * DEG;
    const sLo = up ? layerSin[0] : layerSin[L - 1], sHi = up ? layerSin[L - 1] : layerSin[0];
    const R0 = R[0], R1 = R[1], R2 = R[2], R3 = R[3], R4 = R[4], R5 = R[5], R6 = R[6], R7 = R[7], R8 = R[8];
    const t0 = t[0], t1 = t[1], t2 = t[2], toBeam = 1 / (DEG * o.step), az0 = o.az0 / o.step;
    for (let i = 0; i < N; i++) {
      const d = r[i];
      if (!(d > 0)) continue;
      if (fresh && seenThrough[i]) continue;
      const x = rayX[i] * d, y = rayY[i] * d, z = rayZ[i] * d;
      const qx = R0 * x + R1 * y + R2 * z + t0, qy = R3 * x + R4 * y + R5 * z + t1, qz = R6 * x + R7 * y + R8 * z + t2;
      const dist = Math.sqrt(qx * qx + qy * qy + qz * qz);
      if (dist < 0.3) continue;
      const s = qz / dist;
      if (s < sLo || s > sHi) continue;                         // above or below its fan
      const bf = Math.atan2(qy, qx) * toBeam - az0;
      if (bf < 1 || bf > B - 2) continue;                       // outside its field of view
      let lo = 0, hi = L - 1;                                   // layers l0, l0 + 1 bracket the point's elevation
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if ((up ? layerSin[m] : layerSin[L - 1 - m]) <= s) lo = m; else hi = m;
      }
      const l0 = up ? lo : L - 2 - lo;
      const lateral = adaptive && motionHold[i] > 0 ? moved : 0, ang = lateral / dist;   // isMoving
      const db = 1 + Math.ceil(ang / beamStep), dl = Math.ceil(ang / layerStep);
      const need = dist + c.margin + c.rel * dist + lateral;
      const bLo = Math.max(0, Math.floor(bf) - db), bHi = Math.min(B - 1, Math.ceil(bf) + db);
      const lLo = Math.max(0, l0 - dl), lHi = Math.min(L - 1, l0 + 1 + dl);
      let through = true;
      for (let l = lLo; l <= lHi && through; l++) for (let j = l * B + bLo, je = l * B + bHi; j <= je; j++) {
        if (!(range[j] > need)) { through = false; break; }     // a surface at or in front of the point, or no return
      }
      if (through) { seenThrough[i] = 1; r[i] = 0; removed++; }
    }
  }
  return removed;
}
