// A configured live sensor: its connection (a worker running the CoLa loop, or for tests a scan generator on the
// main thread), what the connection and the REST status poll (status.ts) report about it, and its frames.
import { Stop } from "@mrs6000/server-common/health";
import type { SensorFrame } from "@mrs6000/server-common/sensor/core";
import type { ClockState, SensorStatus } from "@mrs6000/wire/source";
import type { Header } from "@mrs6000/wire/frame";
import type { Scan } from "./model";
import { liveLoop } from "./live/loop";
import type { FromLive, ToLive } from "./live/worker";

/** where a live sensor's scans come from: its CoLa address, or (tests) a scan generator */
export type LiveInput = { kind: "cola"; ip: string; port?: number; layers?: number } | { kind: "scans"; source: () => AsyncIterable<Scan> };

export class LiveSensor {
  label = "sensor";                          // prefix of its error messages
  error = "";
  rate = 0;
  clock: ClockState = { offset_s: 0, drift_ppm: 0, samples: 0, resets: 0 };
  readonly input: LiveInput;
  private _status: Record<string, unknown> = {};
  private worker: Worker | null = null;
  private stop = new Stop();
  private upside: boolean | null = null;

  /** `source`: a CoLa address, or (tests) a scan generator */
  constructor(readonly name: string, source: (() => AsyncIterable<Scan>) | LiveInput, readonly ip = "", readonly retryS = 3) {
    this.input = typeof source === "function" ? { kind: "scans", source } : source;
  }

  /** latest REST device values (status.ts) */
  get status(): Record<string, unknown> { return this._status; }
  set status(s: Record<string, unknown>) {
    this._status = s;
    const v = this.upsideDown;
    if (v !== this.upside) { this.upside = v; this.worker?.postMessage({ type: "upsideDown", value: v } satisfies ToLive); }
  }
  get upsideDown(): boolean | null { const v = this._status.UpsideDown; return typeof v === "boolean" ? v : null; }

  /** connect; every scan goes to `emit` */
  start(emit: (f: SensorFrame) => void): void {
    const status = (s: { error: string; rate: number; clock: ClockState }) => { this.error = s.error; this.rate = s.rate; this.clock = s.clock; };
    if (this.input.kind === "scans") {
      void liveLoop(this.name, this.input.source, this.stop, this.retryS, () => this.upsideDown, emit, status, this.label);
      return;
    }
    const w = new Worker(new URL("./live/worker.ts", import.meta.url));
    let hdr: Header | null = null;
    w.onmessage = (e: MessageEvent<FromLive>) => {
      const m = e.data;
      if (m.type === "status") status(m.status);
      else { hdr = m.frame.hdr ?? hdr; emit({ ...m.frame, hdr: hdr! }); }
    };
    w.onerror = e => { this.error = `${this.label}: worker: ${e.message}`; };
    const i = this.input;
    w.postMessage({ type: "init", name: this.name, label: this.label, ip: i.ip, port: i.port, layers: i.layers, retryS: this.retryS } satisfies ToLive);
    w.postMessage({ type: "upsideDown", value: this.upsideDown } satisfies ToLive);
    this.worker = w;
  }

  close(): void {
    this.stop.set();
    if (this.worker) { const w = this.worker; w.postMessage({ type: "stop" } satisfies ToLive); setTimeout(() => w.terminate(), 200); this.worker = null; }
  }

  info(): SensorStatus {
    return { name: this.name, ip: this.ip, error: this.error, rate: Math.round(this.rate * 100) / 100, clock: this.clock,
             device: typeof this.status.DeviceType === "string" ? this.status.DeviceType : null, upside_down: this.upsideDown };
  }
}
