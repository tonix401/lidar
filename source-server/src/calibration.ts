// Calibrating the rig on the source server: the guided steps of processing's Calibrator (empty scene, then one walk
// through the shared area, then the solve) on the sensors' processed scans. Its own SensorSet runs only while
// calibrating: fed by the live frames, or by a recording from its first frame as fast as the workers go. The
// cross-check is off (with unknown poses the sensors would "see through" each other). The result is kept until
// accepted (stored as the rig) or discarded; `points` is every sensor's empty scene seen from above in the solved
// poses, for checking the result by eye.
import { defaultConfig } from "@mrs6000/processing/config/config";
import { gridCloud, transformCloud } from "@mrs6000/processing/fusion/calib/icp";
import { Calibrator, type CalibratorOptions, type Processed } from "@mrs6000/processing/fusion/calib/calibrator";
import { rigEntry, type SensorCalibration } from "@mrs6000/processing/fusion/calib/rig";
import { toParams } from "@mrs6000/processing/fusion/pose";
import { describeError } from "@mrs6000/server-common/errors";
import type { CalibData, MountSetting, SensorFrame, SensorOutput } from "@mrs6000/server-common/sensor/core";
import { SensorSet } from "@mrs6000/server-common/sensorSet";
import { openRecording, type AnyRecording } from "./recording/session";

export interface CalibrationState {
  target: string;                            // "live" or a recording's name
  phase: Calibrator["phase"]; seconds: number; samples: number[]; ready: boolean; solving: boolean; error: string;
  result: { name: string; pose: ReturnType<typeof toParams>; timeOffset: number; problems: string[]; quality: unknown }[] | null;
}

/** each sensor's empty scene in the world, from above: x, y pairs (m), at most POINTS per sensor */
export interface CalibrationPoints { sensors: { name: string; pose: ReturnType<typeof toParams>; xy: number[] }[] }

const EMPTY = new Float32Array(0), POINTS = 4000;

export class Calibration {
  readonly calibrator: Calibrator;
  readonly set: SensorSet;
  points: CalibrationPoints | null = null;
  private views: Processed[];
  private solving = false;
  private closed = false;
  private busy: number[];

  /** `recording`: calibrate on that recording (its path) instead of the live frames pushed with push() */
  constructor(readonly target: string, readonly names: string[], mounts: MountSetting[], o: CalibratorOptions = {}, recording: string | null = null,
              threaded = true) {
    this.calibrator = new Calibrator(names, o);
    this.views = names.map(() => ({ grid: null, objects: { confirmed: [], bgModel: { ready: false, bg: EMPTY } } }));
    this.busy = names.map(() => 0);
    this.set = new SensorSet(names.map((name, k) => ({ name, mount: mounts[k] })), defaultConfig(), {
      output: (k, out) => { this.busy[k] = Math.max(0, this.busy[k] - 1); this.output(k, out); },
    }, { threaded });
    this.set.crosscheck = false;
    this.calibrator.start();
    if (recording) void this.feed(openRecording(recording));
  }

  get result(): SensorCalibration[] | null { return this.calibrator.result; }

  /** the rig entries to store */
  entries(): Record<string, unknown>[] { return (this.calibrator.result ?? []).map(r => rigEntry(r)); }

  /** a live frame of sensor `name` */
  push(name: string, f: SensorFrame): void {
    const k = this.names.indexOf(name);
    if (k >= 0 && !this.closed && this.active) this.set.push(k, f);
  }

  get active(): boolean { return this.calibrator.phase === "empty" || this.calibrator.phase === "walk"; }

  state(): CalibrationState {
    const c = this.calibrator, p = c.progress();
    return { target: this.target, phase: c.phase, seconds: Math.round(p.seconds * 10) / 10, samples: p.samples, ready: p.ready, solving: this.solving, error: c.error,
             result: c.result?.map(r => ({ name: r.name, pose: toParams(r.pose), timeOffset: r.timeOffset, problems: r.problems,
                                           quality: (rigEntry(r) as { quality?: unknown }).quality ?? null })) ?? null };
  }

  close(): void {
    this.closed = true;
    this.calibrator.cancel();
    this.set.close();
  }

  private output(k: number, o: SensorOutput): void {
    if (!this.active) return;
    this.views[k] = { grid: null, objects: { confirmed: o.tracks, bgModel: { ready: o.bgReady, bg: EMPTY } } };
    this.calibrator.scan(k, o.t, this.views[k], this.views);
    if (this.calibrator.phase === "walk" && this.calibrator.progress().ready && !this.solving) void this.solve();
  }

  /** a recording's frames in order, each sensor's next one once its last is processed */
  private async feed(rec: AnyRecording): Promise<void> {
    try {
      for (let k = 0; k < rec.count && !this.closed && this.active; k++) {
        const { sensor, frame, hdr } = rec.rawFrame(k), i = this.names.indexOf(sensor);
        if (i < 0) continue;
        while (this.busy[i] > 0 && !this.closed) await Bun.sleep(1);
        this.busy[i]++;
        this.set.push(i, { ...frame, hdr, rate: 10, seq: k });
      }
      while (this.busy.some(b => b > 0) && !this.closed) await Bun.sleep(5);
      if (!this.closed && this.active && !this.solving) {
        if (this.calibrator.phase === "walk" && this.calibrator.progress().samples.every(n => n > 0)) await this.solve();
        else this.fail(`${rec.path.split("/").pop()} ended before the ${this.calibrator.phase === "empty" ? "empty scene" : "walk"} was complete`);
      }
    } catch (e) {
      this.fail(describeError(e));
    } finally {
      rec.close();
    }
  }

  private fail(msg: string): void { this.calibrator.error = msg; this.calibrator.phase = "failed"; }

  /** every sensor's rays and empty scene, then the solve in its own thread */
  private async solve(): Promise<void> {
    this.solving = true;
    try {
      const data = await Promise.all(this.set.runners.map(r => r.calibData()));
      const missing = this.names.filter((_, k) => !data[k]);
      if (missing.length) throw new Error(`${missing.join(", ")}: no empty scene yet`);
      const worker = new Worker(new URL("./calibWorker.ts", import.meta.url));
      const reply = await new Promise<{ ok: boolean; result?: SensorCalibration[]; error?: string }>((resolve, reject) => {
        worker.onmessage = e => resolve(e.data);
        worker.onerror = e => reject(new Error(e.message));
        worker.postMessage({ sensors: this.names.map((name, k) => ({ name, data: data[k]!, walk: this.calibrator.walk[k] })) });
      });
      worker.terminate();
      if (!reply.ok) throw new Error(reply.error);
      this.calibrator.result = reply.result!;
      this.calibrator.phase = "done";
      this.points = topDown(reply.result!, data as CalibData[]);
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    } finally {
      this.solving = false;
    }
  }
}

/** each sensor's empty scene in the solved poses, x and y only, thinned to POINTS */
function topDown(result: SensorCalibration[], data: CalibData[]): CalibrationPoints {
  return {
    sensors: result.map((r, k) => {
      const d = data[k], c = transformCloud(gridCloud(d.bg, d.rayX, d.rayY, d.rayZ, d.L, d.B), r.pose), step = Math.max(1, Math.ceil(c.count / POINTS)), xy: number[] = [];
      for (let i = 0; i < c.count; i += step) xy.push(Math.round(c.p[3 * i] * 100) / 100, Math.round(c.p[3 * i + 1] * 100) / 100);
      return { name: r.name, pose: toParams(r.pose), xy };
    }),
  };
}
