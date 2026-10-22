// What the debug page watches: the live sensors, a replay of its own (a stream-mode replay at the source, which it
// controls), or another processing server's replay, watched by its id (its timeline stays that server's). Each
// sensor's newest frame waits in a Feed in the page's format (libs/server-common/src/frames.ts) for its long-poll, and
// `epoch` increments whenever the sequence is not continuous (seek, step back, loop wrap, a reconnect), so the page
// can reset its per-beam history. The server's own fused objects of the same frames are kept next to them.
import { randomBytes } from "node:crypto";
import type { Config } from "@mrs6000/processing/config/config";
import { encodeFrame, scanMeta } from "@mrs6000/server-common/frames";
import { SourcePipeline } from "@mrs6000/server-common/pipeline";
import type { ObjectsTick } from "@mrs6000/server-common/sensorSet";
import type { SourceAddress, SourceFrame, Watch } from "@mrs6000/server-common/sourceClient";
import type { Header } from "@mrs6000/wire/frame";
import type { PlayerState, SensorStatus } from "@mrs6000/wire/source";
import { Feed } from "./feed";

let epochs = 0;                              // unique across views: a page switching between them resets too

export class View {
  readonly id = randomBytes(16).toString("hex");   // a replay's id is what lets a page control it: unguessable, never listed
  readonly pipeline: SourcePipeline;
  readonly feeds = new Map<string, Feed>();
  sensors: string[] = [];
  recording: string | null = null;
  owner = "";                                // a replay's: the processing server that started it
  controls = false;                          // this view's replay is its own: the page may drive it
  epoch = ++epochs;
  replay: PlayerState = {};
  error = "";
  status: SensorStatus[] = [];
  objects: ObjectsTick | null = null;
  lastUsed = performance.now();              // the last request about it (the page long-polls its frames)
  keep = false;                              // never ended for being idle (live, and the "replay" setting's)
  readonly ready: Promise<void>;
  onClosed: ((reason: string) => void) | null = null;   // the source ended it (its owner left, its recording was deleted)
  private sourceEpoch = -1;
  private elev = new Map<Header, Float32Array>();

  constructor(source: SourceAddress, readonly watch: Watch, cfg: Config, objects: boolean) {
    let ok: () => void = () => {}, fail: (e: Error) => void = () => {};
    this.ready = new Promise((resolve, reject) => { ok = resolve; fail = reject; });
    this.ready.catch(() => {});
    this.pipeline = new SourcePipeline(source, watch, cfg, {
      subscribed: s => {
        this.sensors = s.sensors; this.recording = s.recording ?? null; this.owner = s.owner ?? ""; this.controls = !!s.controls;
        this.epoch = ++epochs; this.sourceEpoch = -1; ok();
      },
      frame: f => this.frame(f),
      objects: t => { this.objects = t; },
      state: (r, e) => { this.replay = r; this.error = e; },
      status: s => { this.status = s; },
      closed: reason => { this.error = reason; fail(new Error(reason)); this.onClosed?.(reason); },
      error: e => { this.error = e; fail(new Error(e)); },
    }, { objects });
  }

  get live(): boolean { return this.watch.kind === "live"; }

  /** the source's id of what it watches ("live", or the replay's) */
  get sourceId(): string | null { return this.pipeline.conn.source; }

  feed(name: string): Feed {
    let f = this.feeds.get(name);
    if (!f) this.feeds.set(name, (f = new Feed()));
    return f;
  }

  touch(): void { this.lastUsed = performance.now(); }

  close(): void { this.pipeline.close(); }

  /** the live sensors' errors (and the source connection's), one line */
  liveError(): string {
    const c = this.pipeline.conn;
    return [c.up ? "" : c.error, ...this.status.filter(s => s.error).map(s => s.error)].filter(Boolean).join("; ");
  }

  private frame(f: SourceFrame): void {
    if (!this.live) this.replay = { ...this.replay, index: f.seq };
    if (f.epoch !== this.sourceEpoch) { if (this.sourceEpoch >= 0) this.epoch = ++epochs; this.sourceEpoch = f.epoch; }
    let elev = this.elev.get(f.hdr);
    if (!elev) { if (this.elev.size > 16) this.elev.clear(); this.elev.set(f.hdr, (elev = Float32Array.from(f.hdr.elev))); }
    const { data, points } = encodeFrame(f, f.hdr, elev), h = f.hdr;
    this.feed(f.sensor).publish(data, {
      ...scanMeta(points, h.layers, h.beams, h.start_azimuth_deg, h.step_deg, f.rate, f.t),
      source: this.live ? "live" : "replay", upside_down: h.upside_down ?? null, epoch: this.epoch, sensor: f.sensor, scan: f.seq,
      ...(this.live ? {} : { session: this.id, replay: this.replay }),
    });
  }
}
