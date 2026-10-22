// What the source server holds: the live sensors (always running, recorded on request, sent to every consumer that
// subscribed), the replays consumers asked for, the rig (the live sensors' poses in the registry, a recording's in its
// files' headers) and a calibration. Consumers (ws.ts) and the HTTP API (http.ts) only call these methods.
import { rmSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { CalibratorOptions } from "@mrs6000/processing/fusion/calib/calibrator";
import { NotFoundError, ValueError } from "@mrs6000/server-common/errors";
import { log } from "@mrs6000/server-common/log";
import type { MountSetting, SensorFrame } from "@mrs6000/server-common/sensor/core";
import type { ReplayMode, SensorStatus } from "@mrs6000/wire/source";
import { Calibration } from "./calibration";
import { LiveSensor } from "./live";
import type { RecorderState } from "./recording/recorder";
import { openRecording, Session, SessionRecorder, storeSessionRig } from "./recording/session";
import { recordingPath } from "./recording/catalog";
import { Replay, type ReplayEvents, type ReplayInfo } from "./replay";
import { mergeRig, rigFor, type Rig } from "./rig";
import type { Store } from "./store";

/** what consumers are told about (ws.ts) */
export interface HubEvents {
  liveFrame?(sensor: string, f: SensorFrame): void;
  liveChanged?(sensors: string[]): void;                      // other live sensors (the registry changed)
  rig?(source: string, rig: Rig, version: number): void;     // "live" or a replay's id
  replayClosed?(id: string, reason: string): void;
}

export interface HubState {
  sensors: SensorStatus[]; recording: RecorderState; replays: ReplayInfo[]; calibration: string | null; rigVersion: number;
}

export class Hub {
  live: LiveSensor[] = [];
  readonly replays = new Map<string, Replay>();
  recorder: SessionRecorder;
  calibration: Calibration | null = null;     // one at a time
  events: HubEvents = {};
  rigVersion = 1;
  private seq: number[] = [];

  constructor(public recDir: string, readonly store: Store) {
    this.recorder = new SessionRecorder(recDir, () => rigFor(this.store.rig, this.liveNames()));
  }

  /** keep the recordings in another folder from now on (running replays go on); refused while recording */
  setRecDir(dir: string): void {
    if (dir === this.recDir) return;
    if (this.recorder.active) throw new ValueError("stop the recording first");
    this.recDir = dir;
    this.recorder = new SessionRecorder(dir, () => rigFor(this.store.rig, this.liveNames()));
  }

  // --- the live sensors ---
  liveNames(): string[] { return this.live.map(s => s.name); }

  liveSensor(name: string): LiveSensor {
    const s = this.live.find(x => x.name === name);
    if (!s) throw new NotFoundError(`sensor ${name}`);
    return s;
  }

  /** start these live sensors (instead of the current ones); refused while recording */
  setLive(sensors: LiveSensor[]): void {
    if (this.recorder.active) throw new ValueError("stop the recording first");
    for (const s of this.live) s.close();
    this.stopCalibration();
    this.live = sensors;
    this.seq = sensors.map(() => 0);
    sensors.forEach((s, k) => {
      s.label = sensors.length > 1 ? `sensor ${s.name}` : "sensor";
      s.start(f => this.liveFrame(k, f));
    });
    this.events.liveChanged?.(this.liveNames());
    this.rigChanged("live");
  }

  /** a live sensor's scan: recorded, calibrated with, sent */
  private liveFrame(k: number, f: SensorFrame): void {
    const s = this.live[k];
    if (!s) return;
    const frame = { ...f, seq: this.seq[k]++ };
    this.recorder.writeFrame(s.name, frame, () => frame.hdr);
    if (this.calibration?.target === "live") this.calibration.push(s.name, frame);
    this.events.liveFrame?.(s.name, frame);
  }

  async shutdown(): Promise<void> {
    this.stopCalibration();
    for (const s of this.live) s.close();
    for (const r of [...this.replays.values()]) this.closeReplay(r.id, "server stopping");
    await this.recorder.stop();
  }

  // --- replays ---
  replay(id: string): Replay {
    const r = this.replays.get(id);
    if (!r) throw new NotFoundError(`replay ${id}`);
    return r;
  }

  /** a replay for the consumer `owner` (its name) */
  createReplay(name: string, mode: ReplayMode, events: ReplayEvents, owner = ""): Replay {
    const path = recordingPath(this.recDir, name);
    const r = new Replay(path, mode, events, owner, () => this.recording(path));
    this.replays.set(r.id, r);
    log(`replay ${r.id}: ${r.name} (${mode}${owner ? `, for ${owner}` : ""})`);
    return r;
  }

  closeReplay(id: string, reason = "closed"): void {
    const r = this.replays.get(id);
    if (!r) return;
    r.close();
    this.replays.delete(id);
    this.events.replayClosed?.(id, reason);
  }

  // --- recording ---
  startRecording(path: string | null = null): Promise<string> {
    if (!this.live.length) throw new ValueError("no sensor connected (offline mode)");
    return this.recorder.start(this.liveNames(), path);
  }

  stopRecording(): Promise<void> { return this.recorder.stop(); }

  /** is the file or session folder at `path` being recorded right now? */
  recording(path: string): boolean { return this.recorder.active && !!this.recorder.path && resolve(this.recorder.path) === resolve(path); }

  /** delete a recording (file or session folder): refused while it is being recorded; its replays end first */
  deleteRecording(name: string): void {
    const path = recordingPath(this.recDir, name), rs = this.recorder.state();
    if (rs.active && this.recorder.path && resolve(this.recorder.path) === resolve(path)) throw new ValueError("stop the recording first");
    if (this.calibration?.target === basename(path)) this.stopCalibration();
    for (const r of [...this.replays.values()]) if (resolve(r.path) === resolve(path)) this.closeReplay(r.id, "recording deleted");
    rmSync(path, { recursive: statSync(path).isDirectory(), force: true });
  }

  // --- the rig ---
  /** the poses of a source's sensors: the live rig, or a replay's recording's */
  rig(source: string): Rig {
    return source === "live" ? rigFor(this.store.rig, this.liveNames()) : this.replay(source).rig;
  }

  /** a recording's rig (by name; a single file has none) */
  recordingRig(name: string): Rig {
    const rec = openRecording(recordingPath(this.recDir, name));
    try { return rigFor(rec instanceof Session ? rec.rig : { sensors: [] }, [...rec.sensors]); } finally { rec.close(); }
  }

  rigVersionOf(source: string): number { return source === "live" ? this.rigVersion : this.replay(source).rigVersion; }

  /** store poses: the live rig, or a recording's (in its files' headers; not while it is being recorded) */
  async setRig(update: unknown, recording: string | null = null): Promise<Rig> {
    if (recording === null) {
      const names = new Set(this.store.data.sensors.map(s => s.name)), items = (update as { sensors?: unknown })?.sensors;
      if (Array.isArray(items) && items.some(u => !u || typeof u !== "object" || !names.has((u as { name?: string }).name ?? "")))
        throw new ValueError(`unknown sensor (the registered ones: ${[...names].sort().join(", ")})`);
      this.store.rig = mergeRig(this.store.rig, update);
      this.rigChanged("live");
      return rigFor(this.store.rig, this.store.data.sensors.map(s => s.name));
    }
    const path = recordingPath(this.recDir, recording);
    if (this.recording(path)) throw new ValueError("stop the recording first");
    const session = (() => { try { return new Session(path); } catch { throw new ValueError("a single-sensor recording has no rig to store"); } })();
    let rig: Rig;
    try { rig = mergeRig(session.rig, update); } finally { session.close(); }
    await storeSessionRig(path, rig);
    for (const r of this.replays.values())
      if (resolve(r.path) === resolve(path) && r.rec instanceof Session) { r.rec.rig = rig; this.rigChanged(r.id); }
    return rigFor(rig, session.sensors);
  }

  private rigChanged(source: string): void {
    const version = source === "live" ? ++this.rigVersion : ++this.replay(source).rigVersion;
    this.events.rig?.(source, this.rig(source), version);
  }

  /** each live sensor's mount setting (the registry's) */
  mounts(names: string[]): MountSetting[] {
    return names.map(n => this.store.data.sensors.find(s => s.name === n)?.mount ?? "auto");
  }

  // --- calibration (calibration.ts) ---
  /** calibrate the live sensors, or on a recording (its name) */
  startCalibration(recording: string | null = null, o: CalibratorOptions = {}): Calibration {
    this.stopCalibration();
    let names: string[], path: string | null = null;
    if (recording === null) names = this.liveNames();
    else {
      path = recordingPath(this.recDir, recording);
      if (this.recording(path)) throw new ValueError("stop the recording first");
      const rec = openRecording(path); names = [...rec.sensors]; rec.close();
    }
    if (names.length < 2) throw new ValueError("calibration needs at least two sensors");
    this.calibration = new Calibration(recording === null ? "live" : basename(path!), names, this.mounts(names), o, path);
    return this.calibration;
  }

  /** store the calibration's poses as the rig (of the live sensors or of the recording) */
  acceptCalibration(): Promise<Rig> {
    const c = this.calibration;
    if (!c?.result) throw new ValueError("no calibration result to accept");
    const target = c.target === "live" ? null : c.target, sensors = c.entries();
    this.stopCalibration();
    return this.setRig({ sensors }, target);
  }

  stopCalibration(): void { this.calibration?.close(); this.calibration = null; }

  state(): HubState {
    return { sensors: this.live.map(s => s.info()), recording: this.recorder.state(), replays: [...this.replays.values()].map(r => r.info()),
             calibration: this.calibration?.target ?? null, rigVersion: this.rigVersion };
  }
}
