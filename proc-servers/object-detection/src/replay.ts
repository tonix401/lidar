// A client's replay: a stream-mode replay at the source (its own timeline: play, pause, seek, speed, loop), and its
// objects: from the track cache when this recording was processed with the same settings and poses before
// (trackCache.ts), else from processing its frames (the same code as live, so replayed tracks equal live ones),
// which fills the cache when it plays from the first frame to the last. Others may watch it; only its owner controls it.
import { randomBytes } from "node:crypto";
import type { Config } from "@mrs6000/processing/config/config";
import { SourcePipeline } from "@mrs6000/server-common/pipeline";
import type { ObjectsTick } from "@mrs6000/server-common/sensorSet";
import type { SourceAddress, Subscribed } from "@mrs6000/server-common/sourceClient";
import type { Rig } from "@mrs6000/wire/rig";
import type { Action, PlayerState } from "@mrs6000/wire/source";
import { cacheDir, cacheKey, CacheWriter, hasCache, readCache } from "./trackCache";

export interface ReplayEvents {
  objects?(t: ObjectsTick): void;
  state?(): void;
  closed?(reason: string): void;
}

export interface ReplayInfo { id: string; recording: string; sensors: string[]; objects: "processing" | "cache" | null; clients: number; replay: PlayerState; error: string }

export class ClientReplay {
  readonly id = randomBytes(5).toString("hex");
  readonly pipeline: SourcePipeline;
  sensors: string[] = [];
  count = 0;
  replay: PlayerState = {};
  error = "";
  clients = 0;
  private cached: ObjectsTick[] | null = null;
  private cachedAt = 0;                      // the next cached tick to emit
  private writer: CacheWriter | null = null;
  private last = -1;                         // the last frame shown
  private rig: Rig | null = null;
  private dir: string;
  private onReady: (() => void) | null = null;
  private onFail: ((e: Error) => void) | null = null;
  /** resolves once the source has said what the replay is (its sensors, frames and rig) */
  readonly ready: Promise<void>;

  constructor(readonly recording: string, source: SourceAddress, private cfg: Config, cacheRoot: string,
              private canProcess: () => boolean, private events: ReplayEvents = {}) {
    this.dir = cacheDir(cacheRoot, recording);
    this.ready = new Promise((resolve, reject) => { this.onReady = resolve; this.onFail = reject; });
    this.ready.catch(() => {});
    this.pipeline = new SourcePipeline(source, { kind: "replay", recording, mode: "stream" }, cfg, {
      subscribed: (s: Subscribed) => { this.sensors = s.sensors; this.count = s.count ?? 0; },
      rig: rig => { this.rig = rig; this.choose(); this.onReady?.(); },
      frame: f => this.frame(f.seq),
      objects: t => this.processed(t),
      state: (r, e) => { this.replay = r; this.error = e; events.state?.(); },
      closed: reason => { this.writer?.abort(); this.onFail?.(new Error(reason)); events.closed?.(reason); },
      error: e => { this.error = e; this.onFail?.(new Error(e)); events.state?.(); },
    }, { objects: false });
  }

  /** sending objects: "processing", "cache", or null (not yet known) */
  get objects(): "processing" | "cache" | null { return this.pipeline.set ? "processing" : this.cached ? "cache" : null; }

  control(action: Action, value: number | boolean | null = null): void { this.pipeline.conn.control(action, value); }

  setConfig(cfg: Config): void { this.cfg = cfg; this.pipeline.setConfig(cfg); this.choose(); }

  info(): ReplayInfo {
    return { id: this.id, recording: this.recording, sensors: this.sensors, objects: this.objects, clients: this.clients, replay: this.replay, error: this.error };
  }

  close(): void { this.writer?.abort(); this.pipeline.close(); }

  /** the cache for the current settings and poses, else processing (when the limit allows) */
  private choose(): void {
    if (!this.rig) return;
    const key = cacheKey(this.cfg, this.rig, this.count);
    this.writer?.abort(); this.writer = null;
    if (hasCache(this.dir, key)) {
      this.pipeline.setProcessing(false);
      this.cached = readCache(this.dir, key);
      this.cachedAt = this.firstAfter(this.last);
      return;
    }
    this.cached = null;
    if (!this.pipeline.set && !this.canProcess()) { this.error = "too many replays with processing at once; try again later"; this.events.state?.(); return; }
    this.pipeline.setProcessing(true);
  }

  private frame(k: number): void {
    if (k !== this.last + 1) {                               // a jump: a cache needs one run in order
      this.writer?.abort(); this.writer = null;
      if (this.cached) this.cachedAt = this.firstAfter(k - 1);
    }
    if (k === 0 && this.pipeline.set && this.rig) this.writer = new CacheWriter(this.dir, cacheKey(this.cfg, this.rig, this.count));
    this.last = k;
    if (this.cached) for (const c = this.cached; this.cachedAt < c.length && c[this.cachedAt].k <= k; this.cachedAt++) this.events.objects?.(c[this.cachedAt]);
  }

  private processed(t: ObjectsTick): void {
    this.writer?.add(t);
    this.events.objects?.(t);
    if (this.writer && t.k >= this.count - 1) {             // played through: from now on, the cache
      this.writer.complete(); this.writer = null;
      setTimeout(() => this.choose(), 0);
    }
  }

  /** the first cached tick of a frame after k */
  private firstAfter(k: number): number {
    const c = this.cached!;
    let lo = 0, hi = c.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (c[m].k <= k) lo = m + 1; else hi = m; }
    return lo;
  }
}
