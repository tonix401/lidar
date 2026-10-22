// One sensor's Processor (processor.ts), run in a Web Worker where the browser has them (worker.ts): several
// sensors are then processed in parallel, and the main thread only draws. The page reads the mirror kept here,
// a Grid and an ObjectDetector filled from each processed scan's snapshot (snapshot.ts), as it would read the
// Processor. One scan is processed at a time; frames arriving meanwhile wait, the newest replacing an older
// one (as the frame stream skips frames when the page is slow). Without workers (tests, Node) the Processor
// runs on this thread and the mirror is the Processor itself.
import type { Config } from "@mrs6000/processing/config/config";
import type { FrameMeta, Mount } from "@mrs6000/processing/core/types";
import { ObjectDetector } from "@mrs6000/processing/objects/detector";
import type { OtherSensor } from "@mrs6000/processing/pipeline/crosscheck";
import { createGrid, type Grid } from "@mrs6000/processing/pipeline/grid";
import { Processor } from "@mrs6000/processing/pipeline/processor";
import { applySnapshot } from "./snapshot";
import type { FrameStats } from "@mrs6000/processing/pipeline/steps";
import type { FromWorker, ToWorker } from "./worker";

export interface HostEvents {
  /** a new scan has been processed (`first`: the grid is new) */
  scan(meta: FrameMeta, first: boolean): void;
  /** the spatial stages were re-run in the worker (refine()); on this thread refine() is done on return */
  refined(): void;
  error(e: unknown): void;
}

interface Pending { data: Float32Array; meta: FrameMeta; others: () => OtherSensor[] }

export class ProcessorHost {
  private local: Processor | null = null;
  private worker: Worker | null = null;
  private mirror: { grid: Grid; objects: ObjectDetector; cells: { assign: Int32Array } | null } | null = null;
  private busy = false;
  private pending: Pending | null = null;
  private refineDue = false;
  private gen = 0;                                // bumped by reset(): replies from before it are dropped
  private _cfg: Config;
  private _mount: Mount;
  stats: FrameStats;
  rssiHist: Uint32Array<ArrayBufferLike> = new Uint32Array(50);
  layerBias: Float32Array<ArrayBufferLike> = new Float32Array(24);
  meta: FrameMeta | null = null;
  ts = 0;
  /** called after a layer-calibration update (e.g. to persist the offsets) */
  onLayerBias: ((bias: Float32Array) => void) | null = null;

  constructor(cfg: Config, mount: Mount, private events: HostEvents, threaded = typeof Worker !== "undefined") {
    this._cfg = cfg; this._mount = mount;
    this.stats = new Processor(cfg).stats;
    if (threaded) {
      this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = e => this.reply(e.data as FromWorker);
      this.worker.onerror = e => { this.busy = false; this.events.error(new Error(e.message || "processing worker failed")); };
      this.post({ type: "init", cfg, mount, bias: null });
    } else {
      this.local = new Processor(cfg, mount);
      this.local.onLayerBias = b => this.onLayerBias?.(b);
    }
  }

  get grid(): Grid | null { return this.local ? this.local.grid : this.mirror?.grid ?? null; }
  get objects(): ObjectDetector | null { return this.local ? this.local.objects : this.mirror?.objects ?? null; }
  get cells(): { assign: Int32Array } | null { return this.local ? this.local.cells : this.mirror?.cells ?? null; }
  get cfg(): Config { return this._cfg; }
  set cfg(c: Config) { this._cfg = c; if (this.local) this.local.cfg = c; }   // the worker gets it with each request
  get mount(): Mount { return this._mount; }

  /** process a scan; `others` is asked for when it starts (the other sensors' latest output by then) */
  ingest(data: Float32Array, meta: FrameMeta, others: () => OtherSensor[]): void {
    if (this.local) {
      const first = !this.local.grid;
      this.local.others = others();
      this.local.ingest(data, meta);
      this.copyLocal();
      this.events.scan(meta, first);
      return;
    }
    this.pending = { data, meta, others };
    if (!this.busy) this.next();
  }

  /** re-run the spatial stages on the current state (after a settings change) */
  refine(): void {
    if (this.local) { this.local.refine(); this.copyLocal(); return; }
    if (!this.mirror) return;
    this.refineDue = true;
    if (!this.busy) this.next();
  }

  /** forget per-beam history and tracked objects (seek, source switch, preset change) */
  reset(): void {
    if (this.local) { this.local.reset(); return; }
    this.gen++;
    this.pending = null; this.refineDue = false;
    this.mirror?.objects.reset();
    this.post({ type: "reset", gen: this.gen });
  }

  setMount(m: Mount): void {
    this._mount = m;
    if (this.local) this.local.setMount(m); else this.post({ type: "mount", mount: m });
  }

  setLayerBias(bias: ArrayLike<number>): void {
    if (this.local) { this.local.setLayerBias(bias); this.layerBias = this.local.layerBias; return; }
    this.layerBias = Float32Array.from(bias);
    this.post({ type: "bias", bias: Float32Array.from(bias) });
  }

  dispose(): void { this.worker?.terminate(); this.worker = null; }

  private copyLocal(): void {
    const p = this.local!;
    this.stats = p.stats; this.rssiHist = p.rssiHist; this.layerBias = p.layerBias; this.meta = p.meta; this.ts = p.ts;
  }

  private post(m: ToWorker, transfer: Transferable[] = []): void { this.worker?.postMessage(m, transfer); }

  /** start the next request: the newest waiting scan (it re-runs the spatial stages anyway), else a refine */
  private next(): void {
    const s = this.pending;
    if (s) {
      this.pending = null; this.refineDue = false; this.busy = true;
      this.post({ type: "ingest", gen: this.gen, data: s.data, meta: s.meta, cfg: this._cfg, others: s.others() }, [s.data.buffer]);
    } else if (this.refineDue) {
      this.refineDue = false; this.busy = true;
      this.post({ type: "refine", gen: this.gen, cfg: this._cfg });
    }
  }

  private reply(m: FromWorker): void {
    this.busy = false;
    this.next();                                             // keep the worker busy while this one is applied
    if (m.gen !== this.gen && m.gen >= 0) return;            // from before a reset
    if (m.type === "error") { if (m.message) this.events.error(new Error(m.message)); return; }
    const s = m.snap, first = !this.mirror || this.mirror.grid.L !== s.L || this.mirror.grid.B !== s.B;
    if (first) this.mirror = { grid: createGrid(s.L, s.B), objects: new ObjectDetector(s.L * s.B), cells: null };
    const mi = this.mirror!;
    const assign = applySnapshot(s, mi.grid, mi.objects, mi.cells?.assign ?? null);
    mi.cells = assign ? { assign } : null;
    this.post({ type: "recycle", buf: s.buf }, [s.buf]);
    this.stats = s.stats; this.rssiHist = s.rssiHist; this.layerBias = s.layerBias; this.meta = m.meta; this.ts = s.ts;
    if (s.biasChanged) this.onLayerBias?.(this.layerBias);
    if (m.type === "scan") this.events.scan(m.meta, first); else this.events.refined();
  }
}
