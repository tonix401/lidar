// The guided calibration as a state machine (no DOM; ui/sensorsPanel.ts shows it):
//   empty  — every sensor learns its empty scene; nobody may be in it (2 s with no moving object anywhere)
//   walk   — one person walks a wide loop through the shared area; each sensor's track of them is recorded
//   done   — floor → walk → ICP solved (calibrateRig), waiting to be accepted or discarded
// The walk is ready once it is long enough and covers enough ground: a walk along one line can't fix the turn.
import type { Grid } from "../../pipeline/grid";
import { gridCloud } from "./icp";
import { calibrateRig, type CalibInput, type CalibOptions, type SensorCalibration } from "./rig";
import { walkSpread } from "./walk";

/** what the calibration reads of a sensor's processing: a Processor, the page's mirror of one, or the server's
 *  summary of a sensor worker (its rays, its empty scene, its confirmed tracks) */
export interface Processed {
  readonly grid: Pick<Grid, "L" | "B" | "rayX" | "rayY" | "rayZ"> | null;
  readonly objects: {
    readonly confirmed: readonly { moved: boolean; static: boolean; det: { x: number; y: number; z: number; z0?: number; clipped?: boolean } | null }[];
    readonly bgModel: { readonly ready: boolean; readonly bg: Float32Array };
  } | null;
}

export type CalibPhase = "idle" | "empty" | "walk" | "done" | "failed";

export interface CalibratorOptions {
  walkSeconds?: number; minSamples?: number; emptySeconds?: number;
  minSpread?: number;            // m: the walk's smaller standard deviation, as the sensor that saw most of it saw it
}

export class Calibrator {
  phase: CalibPhase = "idle";
  result: SensorCalibration[] | null = null;
  error = "";
  readonly walk: CalibInput["walk"][];
  private since = 0;              // empty: when the scene was last seen not empty; walk: when it started
  private now = 0;
  private readonly o: Required<CalibratorOptions>;

  constructor(readonly names: string[], o: CalibratorOptions = {}) {
    this.walk = names.map(() => []);
    this.o = { walkSeconds: o.walkSeconds ?? 30, minSamples: o.minSamples ?? 100, emptySeconds: o.emptySeconds ?? 2, minSpread: o.minSpread ?? 0.5 };
  }

  start(): void {
    this.phase = "empty"; this.result = null; this.error = ""; this.since = 0;
    for (const w of this.walk) w.length = 0;
  }

  cancel(): void { this.phase = "idle"; this.result = null; }

  /** sensor k's scan at time t (shared clock) has been processed by `p` */
  scan(k: number, t: number, p: Processed, all: Processed[]): void {
    this.now = Math.max(this.now, t);
    const moving = (q: Processed) => (q.objects?.confirmed ?? []).filter(tr => tr.moved && !tr.static && tr.det);
    if (this.phase === "empty") {
      const busy = all.some(q => !q.objects?.bgModel.ready || moving(q).length > 0);
      if (busy || !this.since) this.since = t;
      else if (t - this.since >= this.o.emptySeconds) { this.phase = "walk"; this.since = t; }
    } else if (this.phase === "walk") {
      const m = moving(p);
      if (m.length === 1) {
        const d = m[0].det!;
        this.walk[k].push({ t, x: d.x, y: d.y, z: d.z, ...(d.z0 !== undefined && d.clipped === false ? { z0: d.z0 } : {}) });
      }
    }
  }

  /** what the panel shows: seconds walked, samples per sensor, the ground covered (m), whether solving makes sense yet */
  progress(): { seconds: number; samples: number[]; spread: number; ready: boolean } {
    const seconds = this.phase === "walk" ? this.now - this.since : 0, samples = this.walk.map(w => w.length);
    const most = this.walk.reduce((a, w) => (w.length > a.length ? w : a), this.walk[0] ?? []), spread = walkSpread(most);
    return { seconds, samples, spread, ready: this.phase === "walk" && seconds >= this.o.walkSeconds && spread >= this.o.minSpread
                                              && samples.every(n => n >= this.o.minSamples) };
  }

  /** floor → walk → ICP from each sensor's empty scene and recorded walk */
  solve(procs: Processed[], o?: CalibOptions): SensorCalibration[] | null {
    try {
      const inputs = procs.map((p, k) => {
        const g = p.grid, bg = p.objects?.bgModel;
        if (!g || !bg?.ready) throw new Error(`${this.names[k]}: no empty scene yet`);
        return { name: this.names[k], cloud: gridCloud(bg.bg, g.rayX, g.rayY, g.rayZ, g.L, g.B), walk: this.walk[k] };
      });
      this.result = calibrateRig(inputs, o);
      this.phase = "done";
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.phase = "failed";
    }
    return this.result;
  }
}
