// Radial cells: an occupancy layer for moving areas that follows what is in a fixed angular wedge instead of
// a single beam (a beam can't follow a moving body). The range image is cut into columns of
// colBeams × colLayers beams, radiating from the sensor. Each column holds up to K depth slots that follow
// the surfaces in it (not fixed range bins, so nothing flickers across bin boundaries):
//  • ingest: the column's moving returns are split into range segments; each segment (its median) is
//    matched to the slot with the nearest predicted range within k·σ + 0.3 m and filtered there with an
//    α-β filter whose gains follow the samples seen (n, capped at `window`), reset when the residual leaves
//    k·σ (real motion is followed at once). Occupancy is OctoMap-style log-odds with clamping: a hit adds,
//    a slot the column was seen through subtracts, an occluded slot decays slowly; a slot turns on after
//    `confirm` hits and off again below zero (hysteresis). A new slot next to a confirmed one at a similar
//    range (the edge of a body moving into the next column) is confirmed at once.
//  • refine: beams of a slot not yet confirmed (spikes, isolated new returns) are dropped, and beams that
//    lost their return are filled from their slot for at most `hold` scans.
// The slot range is deliberately not used to correct the beams: a column mixes surfaces (arm and torso),
// so its median jumps whenever the mix changes, and on the recorded scenes such a correction made moving
// areas jitter more, not less.
import type { Config } from "../config/config";
import type { StageDef } from "../config/types";
import { sameTol } from "../core/math";
import type { Grid } from "./grid";
import { isMoving } from "./motion";

export type CellsConfig = { on: boolean; colBeams: number; colLayers: number; window: number; k: number; confirm: number; hold: number };

export const cellsStage: StageDef<"cells"> = {
  key: "cells", title: "Radial cells (experimental)", toggle: true,
  note: "Off by default: no measurable gain on the recorded scenes (see README). Needs 'Adaptive per area'. Applies to new scans.",
  help: "Occupancy for moving areas that follows a wedge of space instead of a single beam: the range image is cut " +
        "into columns radiating from the sensor, each holding a few depth slots that follow what is in them. A slot " +
        "needs a few hits before it is shown (isolated new returns are dropped; ones touching a confirmed slot are " +
        "shown at once) and fills short dropouts. Colour by 'Radial cell' to see the columns.",
  params: [
    { k: "colBeams", label: "Column width", min: 1, max: 16, step: 1, unit: " beams" },
    { k: "colLayers", label: "Column height", min: 1, max: 6, step: 1, unit: " layers" },
    { k: "window", label: "Max. averaging", min: 1, max: 30, step: 1, unit: " scans" },
    { k: "k", label: "Follow beyond", min: 1, max: 8, step: 0.5, fmt: v => v.toFixed(1) + " σ", edit: { scale: 1, unit: "σ" } },
    { k: "confirm", label: "Show after", min: 1, max: 5, step: 1, unit: " hits" },
    { k: "hold", label: "Fill dropouts for", min: 0, max: 10, step: 1, unit: " scans" } ],
  defaults: { on: false, colBeams: 4, colLayers: 2, window: 5, k: 3, confirm: 2, hold: 2 },
  auto: "user", preset: false, rawOff: true, removed: { label: "Spikes (radial cells)", stat: "spikes" },
};

export const K = 4;
export const HIT = 0.85, MISS = -0.4, DECAY = -0.05, LO_MIN = -2, LO_MAX = 3.5, OFF = 0;
export const GATE_ABS = 0.3, VAR_BETA = 0.1;

/** α-β gains of the expanding-memory polynomial filter after n samples (n = 1: take the sample) */
export const alphaBeta = (n: number): [number, number] => n <= 1 ? [1, 0] : [2 * (2 * n - 1) / (n * (n + 1)), 6 / (n * (n + 1))];

/** same surface, as in motion detection */
const near = (a: number, b: number) => Math.abs(a - b) <= sameTol(Math.min(a, b), 0.15, 0.03);

export class Cells {
  readonly cols: number; readonly colsB: number;
  readonly cb: number; readonly cl: number;       // column size in beams × layers
  // per slot (column * K + k)
  readonly range: Float32Array; readonly vel: Float32Array; readonly var: Float32Array;
  readonly n: Uint16Array; readonly logOdds: Float32Array; readonly on: Uint8Array; readonly hit: Uint8Array;
  // per beam: slot this scan (−1 = none), slot it last belonged to, scans since then, offset to the slot
  readonly assign: Int32Array; readonly last: Int32Array; readonly age: Uint8Array; readonly offset: Float32Array;
  private lastTs = 0;
  private seg: number[] = [];
  private queue: number[] = [];

  constructor(readonly L: number, readonly B: number, cb: number, cl: number) {
    this.cb = Math.max(1, cb | 0); this.cl = Math.max(1, cl | 0);
    this.colsB = Math.ceil(B / this.cb);
    this.cols = this.colsB * Math.ceil(L / this.cl);
    const S = this.cols * K, N = L * B;
    this.range = new Float32Array(S); this.vel = new Float32Array(S); this.var = new Float32Array(S);
    this.n = new Uint16Array(S); this.logOdds = new Float32Array(S); this.on = new Uint8Array(S); this.hit = new Uint8Array(S);
    this.assign = new Int32Array(N).fill(-1); this.last = new Int32Array(N).fill(-1);
    this.age = new Uint8Array(N); this.offset = new Float32Array(N);
  }

  /** same layout as the settings? (else the caller makes a new one) */
  fits(L: number, B: number, c: Config["cells"]): boolean { return L === this.L && B === this.B && c.colBeams === this.cb && c.colLayers === this.cl; }

  reset(): void {
    for (const a of [this.range, this.vel, this.var, this.n, this.logOdds, this.on, this.hit, this.age, this.offset]) a.fill(0);
    this.assign.fill(-1); this.last.fill(-1); this.lastTs = 0;
  }

  /** one scan of per-scan ranges `cur` (acquisition time `ts` in s) */
  update(g: Grid, cur: Float32Array, ts: number, cfg: Config): void {
    const c = cfg.cells, { L, B, cb, cl, colsB } = this;
    const dt = this.lastTs && ts > this.lastTs && ts - this.lastTs < 1 ? ts - this.lastTs : 0.1;
    this.lastTs = ts;
    const floor2 = cfg.temporal.noiseFloor ** 2, onThr = (c.confirm - 0.5) * HIT;
    const { range, vel, var: V, n, logOdds, on, hit, assign, last, age, offset, seg } = this;
    assign.fill(-1);
    for (let i = 0; i < g.N; i++) if (age[i] < 255) age[i]++;
    for (let col = 0; col < this.cols; col++) {
      const l0 = Math.floor(col / colsB) * cl, b0 = (col % colsB) * cb, s0 = col * K;
      // moving returns of this column, sorted by range; and the nearest return of any kind
      seg.length = 0;
      let minAll = Infinity;
      for (let l = l0; l < Math.min(L, l0 + cl); l++) for (let b = b0; b < Math.min(B, b0 + cb); b++) {
        const i = l * B + b, d = cur[i];
        if (d <= 0) continue;
        if (d < minAll) minAll = d;
        if (isMoving(g, i, cfg)) seg.push(i);
      }
      for (let s = s0; s < s0 + K; s++) {                           // predict
        hit[s] = 0;
        if (n[s] > 0) range[s] += vel[s] * dt;
      }
      seg.sort((p, q) => cur[p] - cur[q]);
      for (let a = 0; a < seg.length;) {
        let e = a + 1;                                              // one range segment: no gap > tolerance
        while (e < seg.length && near(cur[seg[e]], cur[seg[e - 1]])) e++;
        const z = cur[seg[(a + e - 1) >> 1]];                       // median
        let s = -1, best = Infinity;
        for (let t = s0; t < s0 + K; t++) {
          if (n[t] === 0 || hit[t]) continue;
          const dist = Math.abs(z - range[t]);
          if (dist <= c.k * Math.sqrt(V[t]) + GATE_ABS && dist < best) { s = t; best = dist; }
        }
        if (s < 0) {                                                // new surface: replace the least occupied slot
          for (let t = s0; t < s0 + K; t++) if (!hit[t] && (s < 0 || n[t] === 0 || (n[s] > 0 && logOdds[t] < logOdds[s]))) s = t;
          if (s < 0) { a = e; continue; }                           // more segments than slots: leave the rest as they are
          range[s] = z; vel[s] = 0; V[s] = floor2; n[s] = 1; logOdds[s] = 0; on[s] = 0;
        } else {
          const r = z - range[s];
          if (Math.abs(r) <= c.k * Math.sqrt(V[s])) {
            n[s] = Math.min(n[s] + 1, Math.max(1, c.window));
            const [al, be] = alphaBeta(n[s]);
            range[s] += al * r; vel[s] += be * r / dt;
            V[s] = Math.max(floor2, V[s] + VAR_BETA * (r * r - V[s]));
          } else { range[s] = z; vel[s] = 0; n[s] = 1; }            // left the gate: follow at once
        }
        hit[s] = 1;
        logOdds[s] = Math.min(LO_MAX, logOdds[s] + HIT);
        for (let h = a; h < e; h++) { const i = seg[h]; assign[i] = s; last[i] = s; age[i] = 0; offset[i] = cur[i] - z; }
        a = e;
      }
      for (let s = s0; s < s0 + K; s++) {
        if (n[s] > 0 && !hit[s]) {                                  // missed: seen through, or occluded
          const through = minAll > range[s] && !near(minAll, range[s]);
          logOdds[s] = Math.max(LO_MIN, logOdds[s] + (through ? MISS : DECAY));
          if (logOdds[s] <= LO_MIN) { n[s] = 0; vel[s] = 0; on[s] = 0; }   // forgotten
        }
        if (logOdds[s] >= onThr) on[s] = 1; else if (logOdds[s] < OFF) on[s] = 0;
      }
    }
    this.confirmNeighbours(onThr);
  }

  /** new slots touching a confirmed slot at a similar range (8 neighbouring columns) are confirmed at once */
  private confirmNeighbours(onThr: number): void {
    const { colsB, cols, range, on, hit, logOdds } = this, Q = this.queue, rows = cols / colsB;
    Q.length = 0;
    for (let s = 0; s < cols * K; s++) if (on[s] && hit[s]) Q.push(s);
    for (let h = 0; h < Q.length; h++) {
      const s = Q[h], col = (s / K) | 0, r = (col / colsB) | 0, cc = col - r * colsB;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, c2 = cc + dc;
        if ((!dr && !dc) || rr < 0 || rr >= rows || c2 < 0 || c2 >= colsB) continue;
        for (let t = (rr * colsB + c2) * K, e = t + K; t < e; t++)
          if (hit[t] && !on[t] && near(range[t], range[s])) { on[t] = 1; logOdds[t] = Math.max(logOdds[t], onThr); Q.push(t); }
      }
    }
  }

  /** applies the occupancy to the moving beams of `D` (in place); `cur` = this scan's per-scan ranges.
   *  Returns the number of beams dropped as unconfirmed. */
  apply(g: Grid, cur: Float32Array, D: Float32Array, cfg: Config): number {
    const hold = cfg.cells.hold, { range, on, n, assign, last, age, offset } = this;
    let dropped = 0;
    for (let i = 0; i < g.N; i++) {
      if (!isMoving(g, i, cfg)) continue;
      const s = assign[i];
      if (s >= 0) { if (!on[s] && D[i] > 0) { D[i] = 0; dropped++; } }
      else if (cur[i] <= 0 && last[i] >= 0 && age[i] <= hold && on[last[i]] && n[last[i]] > 0) {
        D[i] = range[last[i]] + offset[i];                         // lost its return: fill from the slot
      }
    }
    return dropped;
  }
}
