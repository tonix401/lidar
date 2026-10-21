// A replay session: one client's own timeline through a recording (play, pause, seek, speed, loop), independent of
// the live sensors and of everyone else's replays. Others may join it by id to watch the same thing.
//
// What it costs depends on who watches. Debug clients get its raw frames and process them themselves: reading
// and zstd decoding only. Objects clients need the server's tracks: from the cache when this recording was
// processed with the same settings and poses before (trackCache.ts), else the session runs its own sensor workers
// (a SensorSet fed from the file, the same code as live, so replayed tracks equal live ones), counts against the
// limit of processing sessions, and fills the cache when it plays through from start to end.
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { Config } from "@mrs6000/processing/config/config";
import { describeError } from "./errors";
import { Signal } from "./health";
import { nowS } from "./log";
import { Player, type PlayerState } from "./player";
import type { Frame, Header } from "./recording/format";
import { openRecording, Session, type AnyRecording } from "./recording/session";
import { rigFor, type Rig } from "./rig";
import { SensorSet, type ObjectsTick } from "./sensorSet";
import { cacheKey, CacheWriter, readCache, type CachedTick } from "./trackCache";

export interface ReplayFrame { sensor: string; k: number; epoch: number; frame: Frame; hdr: Header; rate: number }

export interface SessionEvents {
  frame?(f: ReplayFrame): void;              // every frame shown (for debug subscribers)
  state?(): void;                            // play / pause / seek / end / error
}

export interface SessionInfo {
  id: string; recording: string; sensors: string[]; objects: "processing" | "cache" | null; clients: number; replay: PlayerState; error: string;
}

export class ReplaySession {
  readonly id = randomBytes(5).toString("hex");
  readonly rec: AnyRecording;
  readonly player = new Player();
  epoch = 0;
  error = "";
  clients = 0;                               // subscribers (the session ends some time after the last one left)
  idleSince = performance.now();
  lastUsed = performance.now();              // last HTTP request about it (the page long-polls its frames)
  keep = false;                              // never ended for being idle (started with --replay)
  private set: SensorSet | null = null;
  private emit: ((t: ObjectsTick) => void) | null = null;   // objects clients are watching
  private cached: CachedTick[] | null = null;              // their ticks, from the cache
  private cachedAt = 0;                                    // the next cached tick to emit
  private writer: CacheWriter | null = null;               // filling the cache in this run
  private changed = new Signal();
  private closed = false;
  private published = new Map<string, number>();

  constructor(readonly path: string, private cfg: Config, private events: SessionEvents = {}) {
    this.rec = openRecording(path);
    this.player.load(openRecording(path));   // the player owns its own reader (it closes it on unload)
    setTimeout(() => void this.loop(), 0);    // after the constructor: the first frame's callback may use the session
  }

  get name(): string { return basename(this.path); }
  get sensors(): string[] { return [...this.rec.sensors]; }
  /** its own sensor workers, while processing */
  get sensorSet(): SensorSet | null { return this.set; }
  /** running its own sensor workers (counts against the limit) */
  get processing(): boolean { return this.set !== null; }
  /** sending objects: "processing", "cache", or null (no objects clients) */
  get objects(): "processing" | "cache" | null { return this.set ? "processing" : this.cached ? "cache" : null; }

  /** the rig the recording was made with (a session's; a single file has none) */
  get rig(): Rig { return rigFor(this.rec instanceof Session ? (this.rec.meta.rig ?? { sensors: [] }) : { sensors: [] }, this.sensors); }

  /** are this recording's tracks cached for the current settings and poses? */
  hasCache(): boolean { return readCache(this.path, cacheKey(this.cfg, this.rig)) !== null; }

  /** objects for its clients, from the cache or its own processing */
  startObjects(mode: "cache" | "processing", emit: (t: ObjectsTick) => void): void {
    this.stopObjects();
    this.emit = emit;
    if (mode === "cache") {
      this.cached = readCache(this.path, cacheKey(this.cfg, this.rig));
      this.cachedAt = this.firstAfter(this.player.shown);
      return;
    }
    const last = this.rec.count - 1;
    this.set = new SensorSet(this.sensors.map(name => ({ name, input: { kind: "frames" as const } })), this.cfg, {
      objects: t => {
        this.writer?.add(t);
        emit(t);
        if (this.writer && t.k >= last) {                          // played through: from now on, the cache
          this.writer.complete(); this.writer = null;
          setTimeout(() => this.restartObjects(), 0);
        }
      },
    });
    this.set.setRig(this.rig);
    if (this.player.shown <= 0) { this.player.index = 0; this.player.dirty = true; this.changed.notify(); }   // frame 0 again, processed: a run from the start
  }

  /** no objects clients any more */
  stopObjects(): void {
    this.set?.close(); this.set = null;
    this.writer?.abort(); this.writer = null;
    this.cached = null; this.emit = null;
  }

  setConfig(cfg: Config): void { this.cfg = cfg; this.restartObjects(); }

  touch(): void { this.lastUsed = performance.now(); }

  /** the recording's rig was changed (calibrated while replaying): its tracks are computed with the new poses */
  rigChanged(): void { this.restartObjects(); }

  control(action: string, value: unknown = null): void {
    this.player.control(action, value);
    this.changed.notify();
    this.events.state?.();
  }

  info(): SessionInfo {
    return { id: this.id, recording: this.name, sensors: this.sensors, objects: this.objects, clients: this.clients, replay: this.player.state(), error: this.error };
  }

  close(): void {
    this.closed = true;
    this.changed.notify();
    this.stopObjects();
    this.player.unload();
    this.rec.close();
  }

  /** settings or poses changed: other tracks (the cache's key changes) */
  private restartObjects(): void {
    const emit = this.emit;
    if (emit) this.startObjects(this.hasCache() ? "cache" : "processing", emit);
  }

  /** the first cached tick of a frame after k */
  private firstAfter(k: number): number {
    const c = this.cached!;
    let lo = 0, hi = c.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (c[m].k <= k) lo = m + 1; else hi = m; }
    return lo;
  }

  private async loop(): Promise<void> {
    while (!this.closed) {
      try {
        await this.step();
      } catch (e) {
        this.error = `${this.name}: ${describeError(e)}`;
        this.player.playing = false;
        this.events.state?.();
        await this.changed.wait(1);
      }
    }
  }

  /** show one frame (and wait until the next is due) */
  private async step(): Promise<void> {
    const p = this.player;
    while (!this.closed && !p.due) await this.changed.wait();
    if (this.closed) return;
    const tStart = nowS(), wasPlaying = p.playing, nxt = p.nextFrame();
    if (!nxt) { await this.changed.wait(0.5); return; }       // nothing complete yet (file still being recorded)
    if (nxt.k !== p.shown + 1) {                              // a jump: start the histories afresh
      this.epoch++;
      this.set?.reset();
      this.writer?.abort(); this.writer = null;                // a cache needs one run in order
      if (this.cached) this.cachedAt = this.firstAfter(nxt.k - 1);
    }
    if (nxt.k === 0 && this.set && !this.writer) this.writer = new CacheWriter(this.path, cacheKey(this.cfg, this.rig));   // a run from the start
    p.shown = nxt.k;
    const { sensor, frame, hdr } = this.reader(nxt.k), now = nowS(), last = this.published.get(sensor) ?? now - 0.1;
    this.published.set(sensor, now);
    const rate = 1 / Math.max(now - last, 1e-3);
    this.events.frame?.({ sensor, k: nxt.k, epoch: this.epoch, frame, hdr, rate });
    if (this.set) this.set.push(this.sensors.indexOf(sensor), { ...frame, hdr, rate, seq: nxt.k });
    if (this.cached) for (const c = this.cached; this.cachedAt < c.length && c[this.cachedAt].k <= nxt.k; this.cachedAt++) this.emit?.(c[this.cachedAt]);
    if (wasPlaying !== p.playing) this.events.state?.();      // reached the end
    const deadline = tStart + nxt.delay;                      // recorded pace, minus decode time
    for (let rem; (rem = deadline - nowS()) > 0 && p.playing && !p.dirty && !this.closed; ) await this.changed.wait(rem);
  }

  private reader(k: number) { return (this.player.rec as AnyRecording).rawFrame(k); }
}
