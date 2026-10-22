// A source's frames through a processing server's sensors: one connection to the source server (sourceClient.ts),
// one SensorSet over its sensors with the rig it sends (each sensor's pose and mount), the per-beam histories reset
// whenever the source says the sequence broke (a new epoch, a reconnect). The fused tracks of each set of scans go to
// `objects`; the frames themselves to `frame` (the debug server relays them).
//
// Pull mode (a recording's every frame, for the track cache): frames are pushed in order, each sensor's next one once
// its last is processed, and credit is granted as they are used, so nothing is dropped and memory stays bounded.
import type { Config } from "@mrs6000/processing/config/config";
import type { Rig } from "@mrs6000/wire/rig";
import type { PlayerState, SensorStatus } from "@mrs6000/wire/source";
import type { MountSetting } from "./sensor/core";
import { SensorSet, type ObjectsTick } from "./sensorSet";
import { SourceConnection, type SourceAddress, type SourceFrame, type Subscribed, type Watch } from "./sourceClient";

export interface PipelineEvents {
  subscribed?(s: Subscribed): void;
  frame?(f: SourceFrame): void;
  objects?(tick: ObjectsTick): void;
  rig?(rig: Rig, version: number): void;
  state?(replay: PlayerState, error: string): void;
  status?(sensors: SensorStatus[]): void;
  end?(): void;                              // pull mode: every frame processed
  closed?(reason: string): void;
  error?(message: string): void;
}

export interface PipelineOptions {
  objects?: boolean;                         // process at all (false: frames only)
  threaded?: boolean;                        // sensor workers (false: the main thread, reproducible to the byte)
  window?: number;                           // pull mode: frames asked for ahead
}

const mountOf = (rig: Rig, name: string): MountSetting => {
  const m = rig.sensors.find(s => s.name === name)?.mount;
  return m === "upright" || m === "upsidedown" ? m : "auto";
};

export class SourcePipeline {
  readonly conn: SourceConnection;
  set: SensorSet | null = null;
  names: string[] = [];
  rig: Rig = { sensors: [] };
  rigVersion = 0;
  epoch = -1;
  error = "";
  private queue: SourceFrame[] = [];         // pull mode: frames waiting for their sensor
  private busy: number[] = [];
  private ended = false;
  private endSent = false;
  private pumping = false;

  constructor(address: SourceAddress, readonly watch: Watch, private cfg: Config, private events: PipelineEvents, private o: PipelineOptions = {}) {
    this.conn = new SourceConnection(address, watch, {
      subscribed: s => this.subscribed(s),
      rig: (rig, version) => { this.rig = rig; this.rigVersion = version; this.applyRig(); events.rig?.(rig, version); },
      frame: f => this.frame(f),
      state: (r, e) => events.state?.(r, e),
      status: s => events.status?.(s),
      end: () => { this.ended = true; this.pump(); },
      closed: reason => events.closed?.(reason),
      error: e => { this.error = e; events.error?.(e); },
    });
  }

  get pull(): boolean { return this.watch.kind === "replay" && this.watch.mode === "pull"; }
  get processing(): boolean { return this.o.objects !== false; }

  setConfig(cfg: Config): void { this.cfg = cfg; this.set?.setConfig(cfg); }

  close(): void { this.conn.close(); this.set?.close(); this.set = null; }

  /** processing on or off (a replay served from the track cache needs only the frames' positions) */
  setProcessing(on: boolean): void {
    if (on === !!this.set) return;
    this.o = { ...this.o, objects: on };
    if (on) this.makeSet(); else { this.set?.close(); this.set = null; }
  }

  private subscribed(s: Subscribed): void {
    this.names = s.sensors;
    this.epoch = -1;
    this.queue = []; this.busy = s.sensors.map(() => 0); this.ended = false; this.endSent = false;
    this.set?.close(); this.set = null;
    if (this.processing) this.makeSet();
    this.events.subscribed?.(s);
    if (this.pull) this.conn.credit(this.window);
  }

  private makeSet(): void {
    this.set = new SensorSet(this.names.map(name => ({ name, mount: mountOf(this.rig, name) })), this.cfg, {
      output: k => { this.busy[k] = Math.max(0, this.busy[k] - 1); if (this.pull) this.pump(); },
      objects: t => this.events.objects?.(t),
      error: e => this.events.error?.(e),
    }, { threaded: this.o.threaded });
    this.applyRig();
  }

  private get window(): number { return this.o.window ?? 16; }

  private applyRig(): void {
    if (!this.set) return;
    this.set.setRig(this.rig);
    this.names.forEach((n, k) => this.set!.runners[k].setMount(mountOf(this.rig, n)));
  }

  private frame(f: SourceFrame): void {
    if (!this.names.includes(f.sensor)) return;            // not (yet) subscribed to it: a new `subscribed` is on its way
    if (f.epoch !== this.epoch) { if (this.epoch >= 0) this.set?.reset(); this.epoch = f.epoch; }
    this.events.frame?.(f);
    if (!this.set) return;
    if (!this.pull) { this.set.push(this.names.indexOf(f.sensor), f); return; }
    this.queue.push(f);
    this.pump();
  }

  /** pull mode: the next frames to their sensors, in order; more credit as frames are used; `end` once all are done */
  private pump(): void {
    if (!this.set || this.pumping) return;               // on the main thread, a push's output calls back in here
    this.pumping = true;
    let used = 0;
    while (this.queue.length) {
      const k = this.names.indexOf(this.queue[0].sensor);
      if (this.busy[k] > 0) break;
      this.busy[k]++;
      this.set.push(k, this.queue.shift()!);
      used++;
    }
    this.pumping = false;
    if (used) this.conn.credit(used);
    if (this.ended && !this.queue.length && this.busy.every(b => b === 0) && !this.endSent) {
      this.endSent = true;
      setTimeout(() => this.events.end?.(), 200);       // the last set (FrameSync waits up to 150 ms for it)
    }
  }
}
