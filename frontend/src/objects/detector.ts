// Object detection for one grid: background model → foreground → segmentation → tracking.
// The pipeline used for fixed ("roadside") LiDARs (Zhao et al. 2019; Wu et al. 3D-DSF), see README.
import type { Config } from "../config/config";
import type { StageDef } from "../config/types";
import { scale } from "../core/colors";
import type { RGB } from "../core/types";
import type { Grid } from "../pipeline/grid";
import { createBackground, foreground, updateBackground, type Background } from "./background";
import { segment } from "./segment";
import { Tracker, type Track } from "./tracker";

export type ObjectsConfig = { on: boolean; scope: number; learn: number; minDiff: number; theta: number; margin: number; minPoints: number; mergeDist: number; gate: number; coast: number };

export const objectsStage: StageDef<"objects"> = {
  key: "objects", title: "Object detection", toggle: true, host: "objects",
  help: "Separates people and objects: learns the empty scene per beam (slowly, so people standing still stay " +
        "visible), takes returns clearly in front of it, groups neighbouring beams that lie on the same surface " +
        "(range-image segmentation, angle criterion), merges fragments, tracks each object with a Kalman filter " +
        "and classifies it from its box (height, footprint, motion).",
  params: [
    { k: "scope", label: "Detect", min: 0, max: 1, step: 1, fmt: v => v ? "foreground + static details" : "foreground only" },
    { k: "learn", label: "Background learning time", min: 2, max: 120, step: 1, unit: " s" },
    { k: "minDiff", label: "Min. distance in front of background", min: 0.05, max: 0.6, step: 0.01, unit: " m" },
    { k: "theta", label: "Segmentation angle θ", min: 2, max: 30, step: 1, unit: "°" },
    { k: "margin", label: "Segmentation noise margin", min: 0, max: 0.3, step: 0.01, unit: " m" },
    { k: "minPoints", label: "Min. points per object", min: 3, max: 100, step: 1 },
    { k: "mergeDist", label: "Merge fragments within", min: 0, max: 1, step: 0.05, unit: " m" },
    { k: "gate", label: "Tracking gate", min: 0.2, max: 2, step: 0.05, unit: " m" },
    { k: "coast", label: "Keep lost objects", min: 0, max: 50, step: 1, fmt: v => `${v} scans (${(v / 10).toFixed(1)} s)`, edit: { scale: 1, unit: "scans" } } ],
  defaults: { on: true, scope: 0, learn: 20, minDiff: 0.15, theta: 10, margin: 0.08, minPoints: 8, mergeDist: 0.3, gate: 0.8, coast: 10 },
  auto: "user", preset: false,
};

export const DIM_BACKGROUND = 0.12, DIM_LIGHT = 0.35;   // share of the colour kept: towards black, towards a light background

/** how background points are dimmed: towards black (dark theme), or towards a light background colour */
export interface TintOptions { selected: number; dimBackground: boolean; dimTo?: RGB }

export class ObjectDetector {
  readonly tracker = new Tracker();
  bgModel: Background;
  readonly fg: Uint8Array;         // foreground mask of the last scan
  readonly cell: Int32Array;       // track id per beam (0 = none)
  readonly hold: Uint8Array;       // beams under a confirmed, non-static track: background must not adopt
  private lab: Int32Array; private queue: Int32Array;
  private lastTs = 0;
  foregroundCount = 0;
  lastMs = 0;

  constructor(readonly N: number) {
    this.bgModel = createBackground(N);
    this.fg = new Uint8Array(N); this.cell = new Int32Array(N); this.hold = new Uint8Array(N);
    this.lab = new Int32Array(N); this.queue = new Int32Array(N);
  }

  get tracks(): Track[] { return this.tracker.tracks; }
  get confirmed(): Track[] { return this.tracker.tracks.filter(t => t.confirmed); }
  get hasConfirmed(): boolean { return this.tracker.tracks.some(t => t.confirmed); }

  reset(): void {
    this.tracker.reset();
    this.bgModel = createBackground(this.N);
    this.cell.fill(0); this.hold.fill(0); this.fg.fill(0);
    this.lastTs = 0; this.foregroundCount = 0;
  }

  /** process one scan of per-scan ranges `cur` (acquisition time `ts` in seconds) */
  update(g: Grid, cur: Float32Array, ts: number, stepDeg: number, cfg: Config): void {
    const c = cfg.objects, t0 = performance.now();
    if (!c.on) { if (this.tracks.length || this.bgModel.ready) this.reset(); return; }
    const dt = this.lastTs && ts > this.lastTs && ts - this.lastTs < 1 ? ts - this.lastTs : 0.1;
    this.lastTs = ts;
    if (!this.bgModel.ready) { updateBackground(this.bgModel, cur, g.noiseVar, this.hold, dt, c); return; }
    this.foregroundCount = foreground(this.bgModel, cur, g.noiseVar, g.area, c, this.fg, g);
    const { detections, starts, queue } = segment({ ...g, stepDeg }, cur, this.fg, c, this.lab, this.queue);
    this.tracker.update(detections, dt, c);
    this.cell.fill(0); this.hold.fill(0);
    for (const t of this.tracks) {
      if (!t.det) continue;
      const hold = t.confirmed && !t.static;
      for (const k of t.det.segments) for (let h = starts[k]; h < starts[k + 1]; h++) {
        this.cell[queue[h]] = t.id;
        if (hold) this.hold[queue[h]] = 1;
      }
    }
    updateBackground(this.bgModel, cur, g.noiseVar, this.hold, dt, c);
    this.lastMs = performance.now() - t0;
  }

  /** colour of beam i with objects highlighted: tracked objects in their colour, the rest dimmed */
  tint(i: number, rgb: RGB, opts: TintOptions): RGB {
    const id = this.cell[i];
    if (id) {
      const t = this.tracker.byId(id);
      if (t && t.confirmed) {
        const c: RGB = t.static ? t.color.map(v => 0.4 + 0.3 * v) as RGB : t.color;
        return opts.selected && id !== opts.selected ? scale(c, 0.45) : c;
      }
      return [0.85, 0.85, 0.85];                      // segmented, not yet confirmed
    }
    return this.tintBackground(rgb, opts);
  }

  /** colour of a background point (not part of any object) */
  tintBackground(rgb: RGB, opts: Omit<TintOptions, "selected">): RGB {
    // dim only while something is highlighted; colours are linear and shown as sRGB: 0.12 ≈ 38 % brightness
    if (!opts.dimBackground || !this.hasConfirmed) return rgb;
    const to = opts.dimTo;
    return to ? [to[0] + (rgb[0] - to[0]) * DIM_LIGHT, to[1] + (rgb[1] - to[1]) * DIM_LIGHT, to[2] + (rgb[2] - to[2]) * DIM_LIGHT]
              : scale(rgb, DIM_BACKGROUND);
  }
}
