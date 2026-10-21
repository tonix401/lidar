// A sensor's processing as the rest of the server sees it: in its own Worker (worker.ts), so several sensors run in
// parallel and the main thread only serves clients, or on the main thread (no workers, and the tests' scan
// generators, which can't be sent to a thread). Either way the same SensorCore runs; events report each frame
// (live sensors: for recording and debug clients), each processed scan, and the connection state.
import type { Config } from "@mrs6000/processing/config/config";
import type { Pose } from "@mrs6000/processing/fusion/pose";
import { colaScans } from "../cola";
import { describeError } from "../errors";
import { Stop } from "../health";
import type { Scan } from "../model";
import type { Header } from "../recording/format";
import { liveLoop, SensorCore, type CalibData, type MountSetting, type OtherScan, type SensorFrame, type SensorOutput, type SensorStatus } from "./core";
import type { FromSensor, SensorInput, ToSensor, WireFrame } from "./worker";

export interface SensorEvents {
  frame?(f: SensorFrame): void;            // a live scan as recorded
  output?(o: SensorOutput): void;          // a processed scan
  status?(s: SensorStatus): void;          // a live sensor's connection
  error?(message: string): void;
}

/** where the scans come from: a CoLa connection, frames pushed by a replay, or (tests) a scan generator */
export type RunnerInput = SensorInput | { kind: "scans"; source: () => AsyncIterable<Scan> };

export interface RunnerOptions { label?: string; retryS?: number; threaded?: boolean; upsideDown?: () => boolean | null }

export class SensorRunner {
  private worker: Worker | null = null;
  private core: SensorCore | null = null;
  private stop = new Stop();
  private inFlight = 0;                      // frames pushed, not processed yet (worker)
  private waiting: SensorFrame | null = null;
  private sentHdr: Header | null = null;     // the last header sent to / received from the worker
  private gotHdr: Header | null = null;
  private calibs = new Map<number, (d: CalibData | null) => void>();
  private calibId = 0;
  dropped = 0;                               // replay frames dropped because the worker was behind

  constructor(readonly name: string, readonly index: number, cfg: Config, mount: MountSetting, readonly input: RunnerInput,
              private events: SensorEvents, o: RunnerOptions = {}) {
    const label = o.label ?? name, retryS = o.retryS ?? 3;
    const threaded = (o.threaded ?? typeof Worker !== "undefined") && input.kind !== "scans";
    if (threaded) {
      this.worker = new Worker(new URL("./worker.ts", import.meta.url));
      this.worker.onmessage = (e: MessageEvent<FromSensor>) => this.received(e.data);
      this.worker.onerror = e => this.events.error?.(`${name}: worker: ${e.message}`);
      this.post({ type: "init", name, label, index, cfg, mount, input: input as SensorInput, retryS });
      return;
    }
    this.core = new SensorCore(name, index, cfg, mount);
    if (input.kind === "frames") return;
    const source = input.kind === "scans" ? input.source : () => colaScans(input.ip, input.layers ?? 24, input.port ?? 2111);
    void liveLoop(name, source, this.stop, retryS, o.upsideDown ?? (() => null), f => {
      const out = this.processHere(f);
      this.events.frame?.(f);
      if (out) this.events.output?.(out);
    }, s => this.events.status?.(s), label);
  }

  /** a replayed frame to process (latest wins while the worker is two behind) */
  push(f: SensorFrame): void {
    if (this.core) { const out = this.processHere(f); if (out) this.events.output?.(out); return; }
    if (this.inFlight >= 2) { if (this.waiting) this.dropped++; this.waiting = f; return; }
    this.send(f);
  }

  /** sensor `index`'s latest scan for this one's cross-check (null: forget it) */
  setOther(index: number, scan: OtherScan | null): void { if (this.core) this.core.setOther(index, scan); else this.post({ type: "other", index, scan }); }
  setConfig(cfg: Config): void { if (this.core) this.core.cfg = cfg; else this.post({ type: "cfg", cfg }); }
  setPose(pose: Pose): void { if (this.core) this.core.pose = pose; else this.post({ type: "pose", pose }); }
  setMount(mount: MountSetting): void { if (this.core) this.core.mount = mount; else this.post({ type: "mount", mount }); }
  /** the device's UpsideDown parameter (REST status), for the recorded header and mount "auto" */
  setUpsideDown(value: boolean | null): void { if (!this.core) this.post({ type: "upsideDown", value }); }
  reset(): void { this.waiting = null; if (this.core) this.core.reset(); else this.post({ type: "reset" }); }

  /** the sensor's rays and empty scene, once it has learned it (calibration) */
  calibData(): Promise<CalibData | null> {
    if (this.core) return Promise.resolve(this.core.calibData());
    const id = ++this.calibId;
    return new Promise(resolve => { this.calibs.set(id, resolve); this.post({ type: "calib", id }); });
  }

  close(): void {
    this.stop.set();
    if (this.worker) { this.post({ type: "stop" }); const w = this.worker; setTimeout(() => w.terminate(), 200); this.worker = null; }
    for (const r of this.calibs.values()) r(null);
    this.calibs.clear();
  }

  private processHere(f: SensorFrame): SensorOutput | null {
    try { return this.core!.process(f); } catch (e) { this.events.error?.(`${this.name}: processing: ${describeError(e)}`); return null; }
  }

  private send(f: SensorFrame): void {
    this.inFlight++;
    const hdr = f.hdr === this.sentHdr ? undefined : (this.sentHdr = f.hdr);
    this.post({ type: "frame", frame: { ...f, hdr } });
  }

  private post(m: ToSensor): void { this.worker?.postMessage(m); }

  private received(m: FromSensor): void {
    switch (m.type) {
      case "frame": this.gotHdr = m.frame.hdr ?? this.gotHdr; this.events.frame?.({ ...(m.frame as WireFrame), hdr: this.gotHdr! }); break;
      case "output":
        if (this.input.kind === "frames") {
          this.inFlight = Math.max(0, this.inFlight - 1);
          const w = this.waiting;
          if (w && this.inFlight < 2) { this.waiting = null; this.send(w); }
        }
        this.events.output?.(m.output);
        break;
      case "status": this.events.status?.(m.status); break;
      case "calib": this.calibs.get(m.id)?.(m.data); this.calibs.delete(m.id); break;
      case "error":
        if (this.input.kind === "frames") this.inFlight = Math.max(0, this.inFlight - 1);
        this.events.error?.(m.message);
        break;
    }
  }
}
