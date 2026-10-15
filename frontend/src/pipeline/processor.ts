// Runs the pipeline (steps.ts) on each organized scan and owns its long-lived state: the grid, the object
// detector, radial cells, the layer calibration. ingest() runs a new scan through every phase; refine()
// re-runs the spatial stages (after settings changes).
import type { Config } from "../config/config";
import type { FrameMeta, Mount } from "../core/types";
import { ObjectDetector } from "../objects/detector";
import type { Cells } from "./cells";
import { createGrid, resetHistory, type Grid } from "./grid";
import { removeUnobservable } from "./layercal";
import { FlickerMeter } from "./metrics";
import { updateRays } from "./rays";
import { PIPELINE, type FrameStats, type Step, type StepContext } from "./steps";

export { LAYERCAL_EVERY, type FrameStats } from "./steps";

const phase = (p: Step["phase"]) => PIPELINE.filter(s => s.phase === p);
const INGEST = phase("ingest"), REFINE = phase("refine"), LEARN = phase("learn");

export class Processor implements StepContext {
  grid: Grid | null = null;
  meta: FrameMeta | null = null;
  ts = 0;
  objects: ObjectDetector | null = null;
  cells: Cells | null = null;
  flickerMeter: FlickerMeter | null = null;
  layerBias = new Float32Array(24);
  rssiHist: Uint32Array<ArrayBufferLike> = new Uint32Array(50);
  stats: FrameStats = { intensity: 0, outliers: 0, flicker: 0, veils: 0, spikes: 0, mixed: 0, wallFill: 0, ingestMs: 0, refineMs: 0, movRough: NaN, movFlicker: NaN };
  scans = 0;
  /** called after a layer-calibration update (e.g. to persist the offsets) */
  onLayerBias: ((bias: Float32Array) => void) | null = null;

  constructor(public cfg: Config, public mount: Mount = "upright") {}

  /** one scan: `data` = float32 [distance m | rssi | elevation deg], each layers × beams */
  ingest(data: Float32Array, meta: FrameMeta): Grid {
    const L = meta.layers, B = meta.beams, N = L * B;
    if (data.length < 3 * N) throw new Error(`frame has ${data.length} values, expected ${3 * N}`);
    if (!this.grid || this.grid.L !== L || this.grid.B !== B) {
      this.grid = createGrid(L, B);
      this.objects = new ObjectDetector(N);
      this.flickerMeter = new FlickerMeter(N);
    }
    const g = this.grid, t0 = performance.now();
    this.meta = meta;
    this.ts = meta.ts || performance.now() / 1000;
    g.rssi.set(data.subarray(N, 2 * N));
    g.elev.set(data.subarray(2 * N, 3 * N));
    g.rawIn.set(data.subarray(0, N));
    updateRays(g, meta.start_azimuth_deg, meta.step_deg, this.mount);   // ~1 ms; elevations may differ per recording
    g.frames = Math.min(g.frames + 1, 32);
    this.stats = { ...this.stats };
    for (const s of INGEST) s.run(this, g, true);
    this.stats.ingestMs = performance.now() - t0;
    this.refine(true);
    for (const s of LEARN) s.run(this, g, true);
    return g;
  }

  /** spatial stages on the current temporal state → grid.out; `scan` = once per new scan (learning steps) */
  refine(scan = false): void {
    const g = this.grid;
    if (!g) return;
    const t0 = performance.now();
    for (const s of REFINE) s.run(this, g, scan);
    this.stats.refineMs = performance.now() - t0;
  }

  background(): Float32Array | null { return this.objects?.bgModel.ready ? this.objects.bgModel.bg : null; }

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
    this.cells?.reset();
    this.flickerMeter?.reset();
  }
}
