// Object detection for one grid: background model → foreground → segmentation → tracking.
// The pipeline used for fixed ("roadside") LiDARs (Zhao et al. 2019; Wu et al. 3D-DSF), see README.
import type { Config } from "../config/config";
import { scale } from "../core/colors";
import type { RGB } from "../core/types";
import type { Grid } from "../pipeline/grid";
import { createBackground, foreground, updateBackground, type Background } from "./background";
import { segment } from "./segment";
import { Tracker, type Track } from "./tracker";

export const DIM_BACKGROUND = 0.12;

export class ObjectDetector {
  readonly tracker = new Tracker();
  bgModel: Background;
  readonly fg: Uint8Array;         // foreground mask of the last scan
  readonly cell: Int32Array;       // track id per beam (0 = none)
  readonly hold: Uint8Array;       // beams under a confirmed, non-static track: background must not adopt
  private lab: Int32Array; private queue: Int32Array;
  private lastTs = 0;
  stats = "";
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
    this.lastTs = 0; this.stats = ""; this.foregroundCount = 0;
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
    const conf = this.confirmed, people = conf.filter(t => t.cls === "person").length;
    this.lastMs = performance.now() - t0;
    this.stats = `${conf.length} object${conf.length === 1 ? "" : "s"} (${people} ${people === 1 ? "person" : "people"}) · ` +
      `${this.foregroundCount.toLocaleString()} foreground beams · ${this.lastMs.toFixed(1)} ms`;
  }

  /** colour of beam i with objects highlighted: tracked objects in their colour, the rest dimmed */
  tint(i: number, rgb: RGB, opts: { selected: number; dimBackground: boolean }): RGB {
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
  tintBackground(rgb: RGB, opts: { dimBackground: boolean }): RGB {
    // dim only while something is highlighted; colours are linear and shown as sRGB: 0.12 ≈ 38 % brightness
    return opts.dimBackground && this.hasConfirmed ? scale(rgb, DIM_BACKGROUND) : rgb;
  }
}
