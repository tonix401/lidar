// The processing pipeline for one organized scan, in order:
//  1 intensity filter → 2 layer calibration → 3 motion detection (unfiltered) → 4 outlier rejection
//  → 5 temporal model → objects (per-scan ranges) → [refine] 6 history filter → 7 bilateral → 8 planes.
// ingest() runs the per-scan stages; refine() re-runs the spatial stages (also after settings changes).
import type { Config } from "../config/config";
import type { FrameMeta, Mount } from "../core/types";
import { ObjectDetector } from "../objects/detector";
import { bilateral } from "./bilateral";
import { createGrid, resetHistory, type Grid } from "./grid";
import { historyFilter } from "./history";
import { intensityFilter, rssiHistogram } from "./intensity";
import { applyLayerBias, removeUnobservable, updateLayerBias } from "./layercal";
import { detectMotion } from "./motion";
import { rejectOutliers } from "./outlier";
import { flattenPlanes } from "./planes";
import { updateRays } from "./rays";
import { temporalUpdate } from "./temporal";

export interface FrameStats { intensity: number; outliers: number; flicker: number; ingestMs: number; refineMs: number }

export const LAYERCAL_EVERY = 10;      // scans between calibration updates

export class Processor {
  grid: Grid | null = null;
  meta: FrameMeta | null = null;
  objects: ObjectDetector | null = null;
  layerBias = new Float32Array(24);
  rssiHist: Uint32Array<ArrayBufferLike> = new Uint32Array(50);
  stats: FrameStats = { intensity: 0, outliers: 0, flicker: 0, ingestMs: 0, refineMs: 0 };
  /** called after a layer-calibration update (e.g. to persist the offsets) */
  onLayerBias: ((bias: Float32Array) => void) | null = null;
  private scans = 0;

  constructor(public cfg: Config, public mount: Mount = "upright") {}

  /** one scan: `data` = float32 [distance m | rssi | elevation deg], each layers × beams */
  ingest(data: Float32Array, meta: FrameMeta): Grid {
    const L = meta.layers, B = meta.beams, N = L * B;
    if (data.length < 3 * N) throw new Error(`frame has ${data.length} values, expected ${3 * N}`);
    if (!this.grid || this.grid.L !== L || this.grid.B !== B) {
      this.grid = createGrid(L, B);
      this.objects = new ObjectDetector(N);
    }
    const g = this.grid, cfg = this.cfg, t0 = performance.now();
    this.meta = meta;
    g.rssi.set(data.subarray(N, 2 * N));
    g.elev.set(data.subarray(2 * N, 3 * N));
    g.rawIn.set(data.subarray(0, N));
    updateRays(g, meta.start_azimuth_deg, meta.step_deg, this.mount);   // ~1 ms; elevations may differ per recording

    this.rssiHist = rssiHistogram(g.rawIn, g.rssi);
    const inp = g.work;                                     // scratch until refine()
    const intensity = intensityFilter(g.rawIn, g.rssi, inp, cfg.intensity);
    if (this.layerBias.length !== L) this.layerBias = new Float32Array(L);
    if (cfg.layercal.on) applyLayerBias(g, inp, this.layerBias);
    g.frames = Math.min(g.frames + 1, 32);
    detectMotion(g, inp, cfg);                              // on the unfiltered scan: moving parts seen whole
    const outliers = rejectOutliers(g, inp, g.raw, cfg);    // relaxed inside moving areas
    temporalUpdate(g, g.raw, cfg);
    if (cfg.layercal.on && cfg.layercal.rate > 0 && ++this.scans % LAYERCAL_EVERY === 0 &&
        updateLayerBias(g, g.temporal, this.layerBias, cfg.layercal.rate)) this.onLayerBias?.(this.layerBias);
    this.objects!.update(g, g.raw, meta.ts || performance.now() / 1000, meta.step_deg, cfg);
    this.stats = { ...this.stats, intensity, outliers, ingestMs: performance.now() - t0 };
    this.refine();
    return g;
  }

  /** spatial stages on the current temporal state → grid.out */
  refine(): void {
    const g = this.grid;
    if (!g) return;
    const t0 = performance.now();
    this.stats.flicker = historyFilter(g, g.temporal, g.hist, this.cfg);
    bilateral(g, g.hist, g.work, this.cfg);
    flattenPlanes(g, g.work, g.out, this.cfg);
    this.stats.refineMs = performance.now() - t0;
  }

  setMount(mount: Mount): void {
    this.mount = mount;
    if (this.grid && this.meta) updateRays(this.grid, this.meta.start_azimuth_deg, this.meta.step_deg, mount);
  }

  setLayerBias(bias: ArrayLike<number>): void {
    this.layerBias = Float32Array.from(bias);
    removeUnobservable(this.layerBias);
  }

  /** forget per-beam history and tracked objects (seek, source switch, preset change) */
  reset(): void {
    if (this.grid) resetHistory(this.grid);
    this.objects?.reset();
  }
}
