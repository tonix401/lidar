// Calibrating the rig on the source server: the guided steps of processing's Calibrator (empty scene, then one walk
// through the shared area, then the solve) on the sensors' processed scans. Its own SensorSet runs only while
// calibrating: fed by the live frames, or by a recording from its first frame as fast as the workers go. The
// cross-check is off (with unknown poses the sensors would "see through" each other). The result is kept until
// accepted (stored as the rig) or discarded; `points` is every sensor's empty scene seen from above in the solved
// poses, for checking the result by eye.
import { defaultConfig } from "@mrs6000/processing/config/config";
import { gridCloud, transformCloud } from "@mrs6000/processing/fusion/calib/icp";
import { Calibrator, type CalibratorOptions, type Processed } from "@mrs6000/processing/fusion/calib/calibrator";
import { moveOrigin, moveRegion } from "@mrs6000/processing/fusion/calib/origin";
import { cropToRegion, type Region } from "@mrs6000/processing/fusion/calib/region";
import { rigEntry, type CalibInput, type SensorCalibration } from "@mrs6000/processing/fusion/calib/rig";
import { toParams } from "@mrs6000/processing/fusion/pose";
import { describeError, ValueError } from "@mrs6000/server-common/errors";
import type { CalibData, MountSetting, SensorFrame, SensorOutput } from "@mrs6000/server-common/sensor/core";
import { SensorSet } from "@mrs6000/server-common/sensorSet";
import { openRecording, type AnyRecording } from "./recording/session";

export interface CalibrationState {
  target: string;                            // "live" or a recording's name
  origin: string; region: Region | null; cut: number;        // the region the solve was limited to, and how many beams and walk samples it left out
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
  region: Region | null = null;
  cut = 0;
  origin: string;                              // the sensor that is the world's origin: the first, until changed
  private data: CalibData[] | null = null;      // what the first solve used, uncropped: every re-solve starts from it
  private views: Processed[];
  private solving = false;
  private closed = false;
  private busy: number[];

  /** `recording`: calibrate on that recording (its path) instead of the live frames pushed with push() */
  constructor(readonly target: string, readonly names: string[], mounts: MountSetting[], o: CalibratorOptions = {}, recording: string | null = null,
              threaded = true) {
    this.calibrator = new Calibrator(names, o);
    this.origin = names[0];
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

  /** the rig entries to store: the poses, and the region drawn on them (null: none, which also clears an earlier one: its world is gone) */
  entries(): Record<string, unknown>[] { return (this.calibrator.result ?? []).map(r => ({ ...rigEntry(r), region: this.region })); }

  /** a live frame of sensor `name` */
  push(name: string, f: SensorFrame): void {
    const k = this.names.indexOf(name);
    if (k >= 0 && !this.closed && this.active) this.set.push(k, f);
  }

  get active(): boolean { return this.calibrator.phase === "empty" || this.calibrator.phase === "walk"; }

  state(): CalibrationState {
    const c = this.calibrator, p = c.progress();
    return { target: this.target, origin: this.origin, region: this.region, cut: this.cut, phase: c.phase, seconds: Math.round(p.seconds * 10) / 10, samples: p.samples, ready: p.ready, solving: this.solving, error: c.error,
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
      this.data = data as CalibData[];
      await this.run(this.data, this.calibrator.walk);
      this.calibrator.phase = "done";
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    } finally {
      this.solving = false;
    }
  }

  /** move the world to `sensor`'s levelled frame (it stands at x = y = yaw = 0 then); the others keep their place relative to it */
  setOrigin(sensor: string): void {
    const res = this.calibrator.result, k = this.names.indexOf(sensor);
    if (this.calibrator.phase !== "done" || !res || !this.data || this.solving) throw new ValueError("there is no finished calibration to change");
    if (k < 0) throw new ValueError(`unknown sensor ${sensor}`);
    const from = res[k].pose;
    this.placeAt(sensor);
    if (this.region) this.region = moveRegion(this.region, from);
  }

  /** the result's poses in the world of `sensor` (a solve gives the first sensor's) */
  private placeAt(sensor: string): void {
    const res = this.calibrator.result!, poses = moveOrigin(res.map(r => r.pose), this.names.indexOf(sensor));
    res.forEach((r, i) => { r.pose = poses[i]; });
    this.origin = sensor;
    this.points = topDown(res, this.data!);
  }

  /** solve again with only what lies inside `region` (world x, y pairs, in the poses of the current result), or with
   *  everything for null. Always from the collected data, so a new region replaces the last instead of adding to it. */
  async resolve(region: Region | null): Promise<void> {
    const prev = this.calibrator.result;
    if (this.calibrator.phase !== "done" || !prev || !this.data || this.solving) throw new ValueError("there is no finished calibration to solve again");
    this.solving = true;
    try {
      let data = this.data, walks = this.calibrator.walk, cut = 0;
      if (region) {
        const c = cropToRegion(this.data.map((d, k) => ({ data: d, walk: this.calibrator.walk[k], pose: prev[k].pose })), region);
        data = c.map(x => x.data); walks = c.map(x => x.walk); cut = c.reduce((n, x) => n + x.cut, 0);
      }
      await this.run(data, walks);
      this.region = region; this.cut = cut;
      if (this.origin !== this.names[0]) this.placeAt(this.origin);   // a solve puts the first sensor at the origin again
    } finally {
      this.solving = false;
    }
  }

  /** the rig solve in a worker, then the result and the view from above */
  private async run(data: CalibData[], walks: CalibInput["walk"][]): Promise<void> {
    const worker = new Worker(new URL("./calibWorker.ts", import.meta.url));
    try {
      const reply = await new Promise<{ ok: boolean; result?: SensorCalibration[]; error?: string }>((resolve, reject) => {
        worker.onmessage = e => resolve(e.data);
        worker.onerror = e => reject(new Error(e.message));
        worker.postMessage({ sensors: this.names.map((name, k) => ({ name, data: data[k], walk: walks[k] })) });
      });
      if (!reply.ok) throw new Error(reply.error);
      this.calibrator.result = reply.result!;
      this.points = topDown(reply.result!, data);
    } finally {
      worker.terminate();
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
