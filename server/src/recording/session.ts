// Multi-sensor recordings ("sessions"): a folder with one .tpc.zstd per sensor and a session.json
//
//   rec_20261020_120000/
//     session.json      {"sensors": [{"name": "a", "file": "a.tpc.zstd"}, ...], "rig": {...}, "created": t,
//                        "complete": false until the recording stopped}
//     a.tpc.zstd  b.tpc.zstd  ...
//
// The scan times of all files are on one clock (the host's, see clock.ts), so a replay merges them into one
// timeline. A single sensor still records a plain .tpc.zstd file.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { describeError, ValueError } from "../errors";
import { stamp } from "../log";
import type { Scan } from "../model";
import { saveJson, type Rig } from "../rig";
import type { Frame, Header } from "./format";
import { Recording, round2, type PublishedFrame, type RecordingInfo } from "./reader";
import { Recorder, type RecorderState } from "./recorder";

export const SESSION_FILE = "session.json";

export interface SessionMeta { sensors: { name: string; file: string }[]; rig?: Rig; created?: number; complete?: boolean; [k: string]: unknown }

export const isSession = (path: string): boolean => {
  try { return statSync(path).isDirectory() && existsSync(join(path, SESSION_FILE)); } catch { return false; }
};

/** A session read as one recording: frame k is the k-th scan in time over all sensors. Grows while it is being
 *  recorded: until session.json says complete, only scans up to the last time every sensor has reached are shown,
 *  so frames are only ever appended (a sensor's chunk lags up to 2.5 s). */
export class Session {
  readonly path: string;
  meta: SessionMeta;
  readonly names: string[];
  readonly recs: Recording[] = [];
  readonly hdr: Header;
  private order: [number, number, number][] = [];  // (time, sensor index, scan index), in time order
  private next: number[];                            // the first scan of each sensor not in `order` yet
  private complete: boolean;

  constructor(path: string) {
    this.path = path;
    let files: string[];
    try {
      this.meta = JSON.parse(readFileSync(join(path, SESSION_FILE), "utf8")) as SessionMeta;
      this.names = this.meta.sensors.map(s => s.name);
      files = this.meta.sensors.map(s => join(path, s.file));
      if (!this.names.length || files.some(f => resolve(dirname(f)) !== resolve(path))) throw new ValueError("bad sensor list");
    } catch (e) {
      throw new ValueError(`not a session (${describeError(e)})`);
    }
    try {
      for (const f of files) this.recs.push(new Recording(f));
    } catch (e) {
      this.close();
      throw e;
    }
    this.hdr = this.recs[0].hdr;
    this.next = this.recs.map(() => 0);
    this.complete = !!this.meta.complete;
  }

  get sensors(): string[] { return this.names; }

  get count(): number { this.merge(); return this.order.length; }

  private merge(): void {
    const counts = this.recs.map(r => r.count);
    if (counts.every((c, i) => c === this.next[i])) return;
    if (!this.complete) {
      try { this.complete = !!JSON.parse(readFileSync(join(this.path, SESSION_FILE), "utf8")).complete; } catch { /* being written */ }
    }
    let cutoff: number;
    if (this.complete) cutoff = Infinity;
    else if (counts.every(c => c > 0)) cutoff = Math.min(...this.recs.map((r, i) => r.time(counts[i] - 1)));
    else return;
    const added: [number, number, number][] = [];
    this.recs.forEach((r, i) => {
      let k = this.next[i];
      for (let t: number; k < counts[i] && (t = r.time(k)) <= cutoff; k++) added.push([t, i, k]);
      this.next[i] = k;
    });
    added.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    for (const a of added) this.order.push(a);
  }

  time(k: number): number { return this.order[k][0]; }

  frame(k: number): PublishedFrame {
    const [, i, j] = this.order[k], { t, data, points } = this.recs[i].encoded(j);
    return { sensor: this.names[i], t, data, points, hdr: this.recs[i].hdr };
  }

  /** frame k as recorded (sensor, raw values, its header): what the server's own processing reads */
  rawFrame(k: number): { sensor: string; frame: Frame; hdr: Header } {
    const [, i, j] = this.order[k];
    return { sensor: this.names[i], frame: this.recs[i].raw(j), hdr: this.recs[i].hdr };
  }

  info(): RecordingInfo {
    const n = this.count;
    return { name: basename(this.path), bytes: this.recs.reduce((s, r) => s + statSync(r.path).size, 0), scans: n,
             seconds: n > 1 ? round2(this.time(n - 1) - this.time(0)) : 0, created: n ? this.time(0) : Number(this.meta.created ?? 0),
             sensors: this.names };
  }

  close(): void { for (const r of this.recs) r.close(); }
}

export type AnyRecording = Recording | Session;

export const openRecording = (path: string): AnyRecording => (existsSync(path) && statSync(path).isDirectory() ? new Session(path) : new Recording(path));

/** Records every live sensor at once: one sensor → a plain .tpc.zstd, several → a session folder. `rig` returns the
 *  current rig, stored in session.json so a replay is self-contained. */
export class SessionRecorder {
  recorders = new Map<string, Recorder>();
  path: string | null = null;               // the file or session folder being recorded
  private session = false;
  private t0 = 0;

  constructor(readonly recDir: string, private rig: () => Rig = () => ({ sensors: [] })) {}

  get active(): boolean { return [...this.recorders.values()].some(r => r.active); }

  async start(names: string[], path: string | null = null): Promise<string> {
    if (this.active) return this.path!;
    await this.stop();
    if (!names.length) throw new ValueError("no sensor to record");
    mkdirSync(this.recDir, { recursive: true });
    this.t0 = Date.now() / 1000;
    if (names.length === 1) {
      const r = new Recorder(this.recDir);
      this.path = r.start(path);
      this.session = false;
      this.recorders = new Map([[names[0], r]]);
    } else {
      const folder = path ?? join(this.recDir, `rec_${stamp()}`);
      if (existsSync(folder)) throw new ValueError(`${basename(folder)} exists already`);
      mkdirSync(folder, { recursive: true });
      this.path = folder; this.session = true;
      this.writeMeta(names, false);
      this.recorders = new Map(names.map(n => {
        const r = new Recorder(this.recDir);
        r.sensor = n;
        r.start(join(folder, `${n}.tpc.zstd`));
        return [n, r];
      }));
    }
    return this.path;
  }

  private writeMeta(names: string[], complete: boolean): void {
    saveJson(join(this.path!, SESSION_FILE), { sensors: names.map(n => ({ name: n, file: `${n}.tpc.zstd` })), rig: this.rig(), created: this.t0, complete });
  }

  write(name: string, scan: Scan, ts: number, upsideDown: boolean | null = null): void {
    const r = this.recorders.get(name);
    if (r) { r.upsideDown = upsideDown; r.write(scan, ts); }
  }

  /** a sensor's scan as recorded (from the server's sensor workers): raw values and the layout header */
  writeFrame(name: string, frame: Frame, header: () => Header): void {
    this.recorders.get(name)?.writeFrame(frame, header);
  }

  async stop(): Promise<void> {
    await Promise.all([...this.recorders.values()].map(r => r.stop()));
    if (this.session && this.path && existsSync(join(this.path, SESSION_FILE))) {
      try { this.writeMeta([...this.recorders.keys()], true); } catch { /* the folder is gone */ }
    }
    this.session = false;
    this.recorders = new Map();
  }

  state(): RecorderState {
    const states = [...this.recorders.values()].map(r => r.state()), errors = states.filter(s => s.error).map(s => s.error);
    if (!states.some(s => s.active)) return { active: false, error: errors[0] ?? "" };
    const out: RecorderState = { active: true, error: errors[0] ?? "", file: basename(this.path!), scans: states.reduce((s, x) => s + (x.scans ?? 0), 0),
                                 bytes: states.reduce((s, x) => s + (x.bytes ?? 0), 0), seconds: Math.round((Date.now() / 1000 - this.t0) * 10) / 10 };
    if (this.session) out.sensors = [...this.recorders.keys()];
    return out;
  }
}
