// Calibrating the rig on the source server: the guided steps of processing's Calibrator (empty scene, then one walk
// through the shared area, then the solve) on the sensors' processed scans. Its own SensorSet runs only while
// calibrating: fed by the live frames, or by a recording from its first frame as fast as the workers go. The
// cross-check is off (with unknown poses the sensors would "see through" each other). The result is kept until
// accepted (stored as the rig) or discarded; `points` is every sensor's empty scene in the solved poses, for checking
// the result by eye. Before accepting, a pose can be set by hand (`adjust`, from the page's views) and the scene
// matched again from there (`refine`). The world is the floor below the main sensor (`origin`).
import { defaultConfig } from "@mrs6000/processing/config/config";
import { gridCloud, transformCloud } from "@mrs6000/processing/fusion/calib/icp";
import { Calibrator, type CalibratorOptions, type Processed } from "@mrs6000/processing/fusion/calib/calibrator";
import { moveRegion, worldChange } from "@mrs6000/processing/fusion/calib/origin";
import { cropToRegion, type Region } from "@mrs6000/processing/fusion/calib/region";
import { rigEntry, type CalibInput, type CalibOptions, type SensorCalibration } from "@mrs6000/processing/fusion/calib/rig";
import { compose, fromParams, toParams, type Pose, type PoseParams } from "@mrs6000/processing/fusion/pose";
import { describeError, ValueError } from "@mrs6000/server-common/errors";
import type { CalibData, MountSetting, SensorFrame, SensorOutput } from "@mrs6000/server-common/sensor/core";
import { SensorSet } from "@mrs6000/server-common/sensorSet";
import { openRecording, type AnyRecording } from "./recording/session";

export interface CalibrationState {
  target: string;                            // "live" or a recording's name
  origin: string; region: Region | null; cut: number;        // the region the solve was limited to, and how many beams and walk samples it left out
  phase: Calibrator["phase"]; seconds: number; samples: number[]; ready: boolean; solving: boolean; error: string;
  result: { name: string; pose: PoseParams; timeOffset: number; problems: string[]; quality: unknown; manual: boolean }[] | null;
}

/** each sensor's empty scene in the world: x, y pairs and the heights (m), at most POINTS per sensor */
export interface CalibrationPoints { sensors: { name: string; pose: PoseParams; xy: number[]; z: number[] }[] }

const EMPTY = new Float32Array(0), POINTS = 4000;

export class Calibration {
  readonly calibrator: Calibrator;
  readonly set: SensorSet;
  points: CalibrationPoints | null = null;
  region: Region | null = null;
  cut = 0;
  origin: string;                              // the main sensor: the world is the floor below it
  readonly heights = new Map<string, number>();  // heights set by hand: used by every later solve
  private manual = new Set<string>();           // sensors whose pose was set by hand since the last solve
  private solved: Pose[] = [];                  // the last solve's poses, for "reset"
  private data: CalibData[] | null = null;      // what the first solve used, uncropped: every re-solve starts from it
  private views: Processed[];
  private solving = false;
  private closed = false;
  private busy: number[];

  /** `recording`: calibrate on that recording (its path) instead of the live frames pushed with push() */
  constructor(readonly target: string, readonly names: string[], mounts: MountSetting[], o: CalibratorOptions = {}, recording: string | null = null,
              threaded = true, origin = names[0]) {
    this.calibrator = new Calibrator(names, o);
    this.origin = names.includes(origin) ? origin : names[0];
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
  entries(): Record<string, unknown>[] {
    return (this.calibrator.result ?? []).map(r => {
      const e = rigEntry(r) as { quality: Record<string, unknown> };
      if (this.manual.has(r.name)) e.quality = { ...e.quality, manual: true };
      return { ...e, main: r.name === this.origin, region: this.region };
    });
  }

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
                                           quality: (rigEntry(r) as { quality?: unknown }).quality ?? null, manual: this.manual.has(r.name) })) ?? null };
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

  private finished(): SensorCalibration[] {
    const res = this.calibrator.result;
    if (this.calibrator.phase !== "done" || !res || !this.data || this.solving) throw new ValueError("there is no finished calibration to change");
    return res;
  }

  private index(sensor: string): number {
    const k = this.names.indexOf(sensor);
    if (k < 0) throw new ValueError(`unknown sensor ${sensor}`);
    return k;
  }

  /** make `sensor` the main one: the world moves to the floor below it; the others keep their place relative to it, and so does the region */
  setOrigin(sensor: string): void {
    const res = this.finished(), W = worldChange(res[this.index(sensor)].pose);
    res.forEach(r => { r.pose = compose(W, r.pose); });
    this.solved = this.solved.map(p => compose(W, p));
    this.origin = sensor;
    this.points = topDown(res, this.data!);
    if (this.region) this.region = moveRegion(this.region, W);
  }

  /** set a sensor's pose by hand. The main sensor stays above the world's origin, facing x: only its height changes.
   *  A height changed by hand counts as measured for every later solve. */
  adjust(sensor: string, pose: PoseParams): void {
    const res = this.finished(), k = this.index(sensor), was = toParams(res[k].pose);
    for (const key of ["x", "y", "z", "yaw"] as const)
      if (typeof pose?.[key] !== "number" || !Number.isFinite(pose[key]) || Math.abs(pose[key]) > 1e4) throw new ValueError(`pose ${key}: expected a number`);
    const now = sensor === this.origin ? { ...was, z: pose.z } : { x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw };
    if (Math.abs(now.z - was.z) > 1e-6) this.heights.set(sensor, now.z);
    res[k].pose = fromParams(now);
    this.manual.add(sensor);
    this.points = topDown(res, this.data!);
  }

  /** the last solve's poses again */
  reset(): void {
    const res = this.finished();
    res.forEach((r, k) => { r.pose = this.solved[k]; });
    this.manual.clear();
    this.points = topDown(res, this.data!);
  }

  /** match the static scene again, from the poses as they are now (after `adjust`) */
  async refine(): Promise<void> {
    const res = this.finished();
    this.solving = true;
    try {
      await this.run(this.data!, this.calibrator.walk, res);
    } finally {
      this.solving = false;
    }
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
    } finally {
      this.solving = false;
    }
  }

  /** the rig solve in a worker (or, with `refine`, the ICP from those poses), then the result and the views */
  private async run(data: CalibData[], walks: CalibInput["walk"][], refine?: SensorCalibration[]): Promise<void> {
    const options: CalibOptions = { origin: this.names.indexOf(this.origin), heights: this.names.map(n => this.heights.get(n) ?? null) };
    const worker = new Worker(new URL("./calibWorker.ts", import.meta.url));
    try {
      const reply = await new Promise<{ ok: boolean; result?: SensorCalibration[]; error?: string }>((resolve, reject) => {
        worker.onmessage = e => resolve(e.data);
        worker.onerror = e => reject(new Error(e.message));
        worker.postMessage({ sensors: this.names.map((name, k) => ({ name, data: data[k], walk: walks[k] })), options, refine });
      });
      if (!reply.ok) throw new Error(reply.error);
      this.calibrator.result = reply.result!;
      if (!refine) this.solved = reply.result!.map(r => r.pose);
      this.manual.clear();
      this.points = topDown(reply.result!, data);
    } finally {
      worker.terminate();
    }
  }
}

/** each sensor's empty scene in the solved poses, thinned to POINTS (the page moves them itself while a pose is dragged) */
function topDown(result: SensorCalibration[], data: CalibData[]): CalibrationPoints {
  const cm = (v: number) => Math.round(v * 100) / 100;
  return {
    sensors: result.map((r, k) => {
      const d = data[k], c = transformCloud(gridCloud(d.bg, d.rayX, d.rayY, d.rayZ, d.L, d.B), r.pose), step = Math.max(1, Math.ceil(c.count / POINTS));
      const xy: number[] = [], z: number[] = [];
      for (let i = 0; i < c.count; i += step) { xy.push(cm(c.p[3 * i]), cm(c.p[3 * i + 1])); z.push(cm(c.p[3 * i + 2])); }
      return { name: r.name, pose: toParams(r.pose), xy, z };
    }),
  };
}
