// A sensor's processing as the rest of a server sees it: in its own Worker (worker.ts), so several sensors run in
// parallel and the main thread only serves clients, or on the main thread (threaded: false: tests, and runs that
// must be reproducible to the byte). Either way the same SensorCore runs on the frames pushed to it.
import type { Config } from "@mrs6000/processing/config/config";
import type { Pose } from "@mrs6000/processing/fusion/pose";
import type { Header } from "@mrs6000/wire/frame";
import { describeError } from "../errors";
import { SensorCore, type CalibData, type MountSetting, type OtherScan, type SensorFrame, type SensorOutput } from "./core";
import type { FromSensor, ToSensor } from "./worker";

export interface SensorEvents {
  output?(o: SensorOutput): void;          // a processed scan
  error?(message: string): void;
}

export interface RunnerOptions { label?: string; threaded?: boolean }

export class SensorRunner {
  private worker: Worker | null = null;
  private core: SensorCore | null = null;
  private inFlight = 0;                      // frames pushed, not processed yet (worker)
  private waiting: SensorFrame | null = null;
  private sentHdr: Header | null = null;     // the last header sent to the worker
  private calibs = new Map<number, (d: CalibData | null) => void>();
  private calibId = 0;
  dropped = 0;                               // frames dropped because the worker was behind

  constructor(readonly name: string, readonly index: number, cfg: Config, mount: MountSetting, private events: SensorEvents,
              o: RunnerOptions = {}) {
    if (o.threaded ?? typeof Worker !== "undefined") {
      this.worker = new Worker(new URL("./worker.ts", import.meta.url));
      this.worker.onmessage = (e: MessageEvent<FromSensor>) => this.received(e.data);
      this.worker.onerror = e => this.events.error?.(`${name}: worker: ${e.message}`);
      this.post({ type: "init", name, label: o.label ?? name, index, cfg, mount });
      return;
    }
    this.core = new SensorCore(name, index, cfg, mount);
  }

  /** a frame to process (latest wins while the worker is two behind; on the main thread, processed at once) */
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
  reset(): void { this.waiting = null; if (this.core) this.core.reset(); else this.post({ type: "reset" }); }

  /** the sensor's rays and empty scene, once it has learned it (calibration) */
  calibData(): Promise<CalibData | null> {
    if (this.core) return Promise.resolve(this.core.calibData());
    const id = ++this.calibId;
    return new Promise(resolve => { this.calibs.set(id, resolve); this.post({ type: "calib", id }); });
  }

  close(): void {
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
      case "output": {
        this.inFlight = Math.max(0, this.inFlight - 1);
        const w = this.waiting;
        if (w && this.inFlight < 2) { this.waiting = null; this.send(w); }
        this.events.output?.(m.output);
        break;
      }
      case "calib": this.calibs.get(m.id)?.(m.data); this.calibs.delete(m.id); break;
      case "error":
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.events.error?.(m.message);
        break;
    }
  }
}
