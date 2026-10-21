// A recording's tracks computed in the background, as fast as the sensor workers go (not at the recorded pace), into
// the track cache (trackCache.ts): afterwards, objects replays of it cost almost nothing. Every frame is processed
// (each sensor gets its next frame once its last one is done), in recorded order.
import { basename } from "node:path";
import type { Config } from "@mrs6000/processing/config/config";
import { describeError } from "./errors";
import { log } from "./log";
import { openRecording, Session } from "./recording/session";
import { rigFor } from "./rig";
import { SensorSet } from "./sensorSet";
import { cacheKey, CacheWriter } from "./trackCache";

export interface BatchState { recording: string; done: number; total: number; running: boolean; error: string; seconds: number }

export class BatchJob {
  done = 0;
  total = 0;
  running = true;
  error = "";
  private t0 = performance.now();
  private cancelled = false;
  readonly finished: Promise<void>;

  constructor(readonly path: string, cfg: Config) { this.finished = this.run(cfg); }

  cancel(): void { this.cancelled = true; }

  state(): BatchState {
    return { recording: basename(this.path), done: this.done, total: this.total, running: this.running, error: this.error,
             seconds: Math.round((performance.now() - this.t0) / 100) / 10 };
  }

  private async run(cfg: Config): Promise<void> {
    const rec = openRecording(this.path), names = [...rec.sensors];
    const rig = rigFor(rec instanceof Session ? (rec.meta.rig ?? { sensors: [] }) : { sensors: [] }, names);
    const writer = new CacheWriter(this.path, cacheKey(cfg, rig)), busy = names.map(() => 0);
    let wake: (() => void) | null = null;
    const set = new SensorSet(names.map(name => ({ name, input: { kind: "frames" as const } })), cfg, {
      output: k => { busy[k]--; wake?.(); },
      error: () => {},
      objects: t => writer.add(t),
    });
    set.setRig(rig);
    const idle = (k: number) => new Promise<void>(r => { const check = () => (busy[k] < 1 ? r() : (wake = check)); check(); });
    try {
      this.total = rec.count;
      for (let k = 0; k < this.total && !this.cancelled; k++) {
        const { sensor, frame, hdr } = rec.rawFrame(k), i = names.indexOf(sensor);
        await idle(i);
        busy[i]++;
        set.push(i, { ...frame, hdr, rate: 10, seq: k });
        this.done = k + 1;
      }
      for (let i = 0; i < names.length; i++) await idle(i);
      await Bun.sleep(200);                               // the last set (FrameSync waits up to 150 ms for it)
      if (this.cancelled) writer.abort(); else { writer.complete(); log(`tracks of ${basename(this.path)} computed (${this.state().seconds} s)`); }
    } catch (e) {
      this.error = describeError(e);
      writer.abort();
    } finally {
      set.close();
      rec.close();
      this.running = false;
    }
  }
}
