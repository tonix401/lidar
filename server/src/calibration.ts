// Calibrating a rig on the server (no page needed): the guided steps of processing's Calibrator (empty scene, then
// one walk through the shared area, then the solve) on a SensorSet's outputs: the live sensors, or a replay
// session's processing. The cross-check is off meanwhile (with unknown poses the sensors would "see through" each
// other). The result is kept until accepted (stored as the rig: rig.ts) or discarded.
import { Calibrator, type CalibratorOptions, type Processed } from "@mrs6000/processing/fusion/calib/calibrator";
import { rigEntry, type SensorCalibration } from "@mrs6000/processing/fusion/calib/rig";
import { toParams } from "@mrs6000/processing/fusion/pose";
import type { SensorOutput } from "./sensor/core";
import type { SensorSet } from "./sensorSet";

export interface CalibrationState {
  target: string;                            // "live" or a session id
  phase: Calibrator["phase"]; seconds: number; samples: number[]; ready: boolean; solving: boolean; error: string;
  result: { name: string; pose: ReturnType<typeof toParams>; timeOffset: number; problems: string[] }[] | null;
}

const EMPTY = new Float32Array(0);

export class Calibration {
  readonly calibrator: Calibrator;
  private views: Processed[];
  private solving = false;
  private listener = (k: number, o: SensorOutput) => this.output(k, o);

  constructor(readonly target: string, private set: SensorSet, o: CalibratorOptions = {}) {
    this.calibrator = new Calibrator(set.names, o);
    this.views = set.names.map(() => ({ grid: null, objects: { confirmed: [], bgModel: { ready: false, bg: EMPTY } } }));
    set.crosscheck = false;
    set.outputs.add(this.listener);
    this.calibrator.start();
  }

  get result(): SensorCalibration[] | null { return this.calibrator.result; }

  /** the rig entries to store (rig.ts) */
  entries(): Record<string, unknown>[] { return (this.calibrator.result ?? []).map(r => rigEntry(r)); }

  state(): CalibrationState {
    const c = this.calibrator, p = c.progress();
    return { target: this.target, phase: c.phase, seconds: Math.round(p.seconds * 10) / 10, samples: p.samples, ready: p.ready, solving: this.solving, error: c.error,
             result: c.result?.map(r => ({ name: r.name, pose: toParams(r.pose), timeOffset: r.timeOffset, problems: r.problems })) ?? null };
  }

  close(): void {
    this.set.outputs.delete(this.listener);
    this.set.crosscheck = true;
    this.calibrator.cancel();
  }

  private output(k: number, o: SensorOutput): void {
    this.views[k] = { grid: null, objects: { confirmed: o.tracks, bgModel: { ready: o.bgReady, bg: EMPTY } } };
    this.calibrator.scan(k, o.t, this.views[k], this.views);
    if (this.calibrator.phase === "walk" && this.calibrator.progress().ready && !this.solving) void this.solve();
  }

  /** every sensor's rays and empty scene, then the solve in its own thread */
  private async solve(): Promise<void> {
    this.solving = true;
    try {
      const data = await Promise.all(this.set.runners.map(r => r.calibData()));
      const missing = this.set.names.filter((_, k) => !data[k]);
      if (missing.length) throw new Error(`${missing.join(", ")}: no empty scene yet`);
      const worker = new Worker(new URL("./calibWorker.ts", import.meta.url));
      const reply = await new Promise<{ ok: boolean; result?: SensorCalibration[]; error?: string }>((resolve, reject) => {
        worker.onmessage = e => resolve(e.data);
        worker.onerror = e => reject(new Error(e.message));
        worker.postMessage({ sensors: this.set.names.map((name, k) => ({ name, data: data[k]!, walk: this.calibrator.walk[k] })) });
      });
      worker.terminate();
      if (!reply.ok) throw new Error(reply.error);
      this.calibrator.result = reply.result!;
      this.calibrator.phase = "done";
    } catch (e) {
      this.calibrator.error = e instanceof Error ? e.message : String(e);
      this.calibrator.phase = "failed";
    } finally {
      this.solving = false;
    }
  }
}
