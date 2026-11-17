// Multi-sensor recordings ("sessions"): a folder with one .tpc.zstd (or .tpc) per sensor
//
//   rec_20261020_120000/
//     a.tpc.zstd  b.tpc.zstd  ...
//
// Each file's header says which sensor it is, its place in the session (index 0: the first sensor, the world's
// origin), when the recording started, and where the sensor stood (its rig entry; format.ts, RecordingMeta). The
// scan times of all files are on one clock (the host's, see clock.ts), so a replay merges them into one timeline.
// A single sensor still records a plain .tpc.zstd file.
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describeError, ValueError } from "@mrs6000/server-common/errors";
import { stamp } from "@mrs6000/server-common/log";
import type { Scan } from "../model";
import { type Rig, type RigSensor } from "@mrs6000/wire/rig";
import type { Frame, Header, RecordingMeta } from "./format";
import { Recording, rewriteHeader, round2, type PublishedFrame, type RecordingInfo } from "./reader";
import { Recorder, type RecorderState } from "./recorder";

const FILE_RE = /\.tpc(\.zstd)?$/;
const RIG_KEYS = ["pose", "time_offset_s", "calibrated", "quality", "region"] as const;   // what a header's rig entry keeps

/** the files of a session folder (none: not a session) */
export const sessionFiles = (path: string): string[] => {
  try { return statSync(path).isDirectory() ? readdirSync(path).filter(f => FILE_RE.test(f)).sort() : []; } catch { return []; }
};

export const isSession = (path: string): boolean => sessionFiles(path).length > 0;

/** a sensor's rig entry as a header keeps it (its pose and calibration, not the registry's address or mount) */
export function rigEntry(s: RigSensor | undefined): RecordingMeta["rig"] {
  const out: Record<string, unknown> = {};
  for (const k of RIG_KEYS) if (s?.[k] !== undefined) out[k] = s[k];
  return out;
}

/** A session read as one recording: frame k is the k-th scan in time over all sensors. Grows while it is being
 *  recorded (`growing`: the source server is still recording it): until then, only scans up to the last time every
 *  sensor has reached are shown, so frames are only ever appended (a sensor's chunk lags up to 2.5 s). */
export class Session {
  readonly path: string;
  readonly names: string[];
  readonly recs: Recording[] = [];
  readonly hdr: Header;
  private order: [number, number, number][] = [];  // (time, sensor index, scan index), in time order
  private next: number[];                            // the first scan of each sensor not in `order` yet

  constructor(path: string, private growing: () => boolean = () => false) {
    this.path = path;
    const files = sessionFiles(path);
    if (!files.length) throw new ValueError("not a session (no .tpc or .tpc.zstd files in it)");
    try {
      for (const f of files) this.recs.push(new Recording(join(path, f)));
    } catch (e) {
      this.close();
      throw new ValueError(`not a session (${describeError(e)})`);
    }
    const name = (r: Recording) => r.hdr.sensor || basename(r.path).replace(FILE_RE, "");
    this.recs.sort((a, b) => (a.meta.index ?? Infinity) - (b.meta.index ?? Infinity) || name(a).localeCompare(name(b)));
    this.names = this.recs.map(name);
    if (new Set(this.names).size !== this.names.length) { this.close(); throw new ValueError("not a session (two files of the same sensor)"); }
    this.hdr = this.recs[0].hdr;
    this.next = this.recs.map(() => 0);
  }

  /** the poses the session was recorded or calibrated with */
  get rig(): Rig { return { sensors: this.recs.map((r, i) => ({ name: this.names[i], ...r.meta.rig })) }; }
  set rig(rig: Rig) {
    const byName = new Map(rig.sensors.map(s => [s.name, s]));
    this.recs.forEach((r, i) => { r.meta = { ...r.meta, rig: rigEntry(byName.get(this.names[i])) }; });
  }

  /** when the recording started (the headers' `created`, else its first scan) */
  get created(): number { return Math.min(...this.recs.map(r => r.meta.created ?? Infinity)); }

  get sensors(): string[] { return this.names; }

  get count(): number { this.merge(); return this.order.length; }

  private merge(): void {
    const counts = this.recs.map(r => r.count);
    if (counts.every((c, i) => c === this.next[i])) return;
    let cutoff: number;
    if (!this.growing()) cutoff = Infinity;
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
             seconds: n > 1 ? round2(this.time(n - 1) - this.time(0)) : 0, created: n ? this.time(0) : (Number.isFinite(this.created) ? this.created : 0),
             sensors: this.names };
  }

  close(): void { for (const r of this.recs) r.close(); }
}

export type AnyRecording = Recording | Session;

/** a session folder or a single file; `growing`: whether the source server is still recording it */
export const openRecording = (path: string, growing: () => boolean = () => false): AnyRecording =>
  (existsSync(path) && statSync(path).isDirectory() ? new Session(path, growing) : new Recording(path));

/** store a session's poses in its files' headers (each file is written anew, its scans as they are) */
export async function storeSessionRig(path: string, rig: Rig): Promise<void> {
  const s = new Session(path);
  try {
    s.rig = rig;
    for (const r of s.recs) await rewriteHeader(r, r.hdr, r.meta);
  } finally {
    s.close();
  }
}

/** Records every live sensor at once: one sensor → a plain .tpc.zstd, several → a session folder. `rig` returns the
 *  current rig, stored in each file's header so a replay is self-contained. */
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
      r.extra = { sensor: names[0], created: this.t0 };
      this.path = r.start(path);
      this.session = false;
      this.recorders = new Map([[names[0], r]]);
    } else {
      const folder = path ?? join(this.recDir, `rec_${stamp()}`);
      if (existsSync(folder)) throw new ValueError(`${basename(folder)} exists already`);
      mkdirSync(folder, { recursive: true });
      this.path = folder; this.session = true;
      const rig = new Map(this.rig().sensors.map(s => [s.name, s]));
      this.recorders = new Map(names.map((n, index) => {
        const r = new Recorder(this.recDir);
        r.extra = { sensor: n, index, created: this.t0, rig: rigEntry(rig.get(n)) } satisfies RecordingMeta & { sensor: string };
        r.start(join(folder, `${n}.tpc.zstd`));
        return [n, r];
      }));
    }
    return this.path;
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
