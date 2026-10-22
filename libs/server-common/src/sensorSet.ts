// Sensors processed together: the live rig, or the sensors of a recording being replayed. Each runs
// in its own worker (sensor/runner.ts); here their outputs meet. Each sensor's filtered scan goes to the others for
// their cross-check (between calibrated sensors only), the scans are grouped into sets (fusion/sync.ts: every
// sending sensor once, or 150 ms), and each set's observations are fused into world tracks (fusion/objects.ts).
import type { Config } from "@mrs6000/processing/config/config";
import { ObjectFusion } from "@mrs6000/processing/fusion/objects";
import { compose, fromParams, IDENTITY, invert, type Pose } from "@mrs6000/processing/fusion/pose";
import { FrameSync } from "@mrs6000/processing/fusion/sync";
import type { Header } from "@mrs6000/wire/frame";
import type { WorldObject } from "@mrs6000/wire/objects";
import type { Rig } from "@mrs6000/wire/rig";
import { worldObjects } from "./objects";
import type { MountSetting, SensorFrame, SensorOutput } from "./sensor/core";
import { SensorRunner, type RunnerOptions } from "./sensor/runner";

export const SENDING_MS = 500;               // a sensor silent this long is not waited for, nor cross-checked against

export interface SetSensor { name: string; mount?: MountSetting; label?: string }

/** one set of scans fused: the world tracks at time t (the newest scan of the set), and which sensors took part */
export interface ObjectsTick { t: number; seq: number; k: number; sensors: number[]; objects: WorldObject[] }   // k: the newest frame's seq

export interface SetEvents {
  output?(k: number, o: SensorOutput): void;
  error?(message: string): void;
  objects?(tick: ObjectsTick): void;
}

export class SensorSet {
  readonly runners: SensorRunner[];
  readonly fusion = new ObjectFusion();
  readonly latest: (SensorOutput | null)[];
  private hdrs: (Header | null)[];
  private at: number[];                      // performance.now() of each sensor's last output
  private poses: Pose[];
  private calibrated: boolean[];
  private sync = new FrameSync();
  private timer: ReturnType<typeof setInterval>;
  private seq = 0;
  crosscheck = true;                         // off during a calibration (wrong poses would "see through" everything)
  private shared: boolean[];                 // sensor k's scans go to the others' cross-check
  /** more listeners to every processed scan (a calibration) */
  readonly outputs = new Set<(k: number, o: SensorOutput) => void>();

  constructor(readonly sensors: SetSensor[], private cfg: Config, private events: SetEvents, o: RunnerOptions = {}) {
    const n = sensors.length;
    this.latest = Array(n).fill(null); this.hdrs = Array(n).fill(null); this.at = Array(n).fill(0);
    this.poses = Array(n).fill(IDENTITY); this.calibrated = Array(n).fill(false); this.shared = Array(n).fill(false);
    this.runners = sensors.map((s, k) => new SensorRunner(s.name, k, cfg, s.mount ?? "auto", {
      output: out => this.output(k, out),
      error: msg => events.error?.(msg),
    }, { ...o, label: s.label ?? o.label }));
    this.timer = setInterval(() => this.fuse(this.sync.poll(performance.now())), 20);
  }

  get names(): string[] { return this.sensors.map(s => s.name); }

  /** poses from the rig (sensors without a calibrated pose sit at the origin and are not cross-checked) */
  setRig(rig: Rig): void {
    this.sensors.forEach((s, k) => {
      const e = rig.sensors.find(r => r.name === s.name);
      this.poses[k] = e?.pose ? fromParams(e.pose) : IDENTITY;
      this.calibrated[k] = !!e?.pose && !!e.calibrated;
      this.runners[k].setPose(this.poses[k]);
    });
    this.fusion.reset();
  }

  setConfig(cfg: Config): void {
    this.cfg = cfg;
    for (const r of this.runners) r.setConfig(cfg);
    if (!cfg.objects.on) this.fusion.reset();
  }

  /** a frame of sensor k (the header tells its layout) */
  push(k: number, f: SensorFrame): void { this.hdrs[k] = f.hdr; this.runners[k].push(f); }

  /** forget every sensor's history and the tracks (a jump in a replay) */
  reset(): void {
    for (const r of this.runners) r.reset();
    this.latest.fill(null); this.fusion.reset(); this.sync.reset();
  }

  close(): void { clearInterval(this.timer); for (const r of this.runners) r.close(); }

  private output(k: number, out: SensorOutput): void {
    this.latest[k] = out;
    this.at[k] = performance.now();
    this.events.output?.(k, out);
    for (const f of this.outputs) f(k, out);
    if (this.sensors.length > 1) this.shareScan(k);
    this.fuse(this.sync.add(k, this.at[k], this.sending()));
  }

  /** the sensors whose scans are arriving: a set waits for these */
  private sending(): number[] {
    const now = performance.now();
    return this.at.flatMap((t, k) => (t && now - t < SENDING_MS ? [k] : []));
  }

  /** sensor m's new filtered scan, to the other calibrated sensors for their cross-check (only this one: each
   *  worker keeps the others' latest, and leaves out those gone quiet) */
  private shareScan(m: number): void {
    const off = !this.crosscheck || !this.cfg.crosscheck.on, o = this.latest[m], hdr = this.hdrs[m];
    if (off || !o || !hdr || !this.calibrated[m]) {
      if (this.shared[m]) { for (const [j, r] of this.runners.entries()) if (j !== m) r.setOther(m, null); this.shared[m] = false; }
      return;
    }
    const L = hdr.layers, B = hdr.beams, zs = hdr.upside_down ? -1 : 1;
    const layerSin = Float32Array.from({ length: L }, (_, l) => zs * Math.sin(hdr.elev[l * B + (B >> 1)] * Math.PI / 180));
    this.runners.forEach((r, j) => {
      if (j === m || !this.calibrated[j]) return;
      const T = compose(invert(this.poses[m]), this.poses[j]);       // j's frame → m's
      r.setOther(m, { R: T.R, t: T.t, L, B, az0: hdr.start_azimuth_deg, step: hdr.step_deg, layerSin, range: o.raw, age: 0, scanT: o.t });
    });
    this.shared[m] = true;
  }

  private fuse(ks: number[]): void {
    if (!ks.length) return;
    const t = Math.max(...ks.map(k => this.latest[k]?.t ?? 0)), newest = Math.max(...ks.map(k => this.latest[k]?.seq ?? 0));
    if (this.cfg.objects.on) this.fusion.update(this.latest.flatMap(o => o?.observations ?? []), t, this.cfg.objects);
    this.events.objects?.({ t, seq: this.seq++, k: newest, sensors: ks, objects: worldObjects(this.fusion.objects, this.names) });   // a snapshot: tracks change in place
  }
}
