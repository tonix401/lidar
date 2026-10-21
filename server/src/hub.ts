// The sources clients watch: the live sensors (always running, shared by everyone) and replay sessions (each
// client's own timeline through a recording, replay.ts).
//
// The live sensors each run in their own worker (sensorSet.ts: connection, clock, objects-only processing), so
// recording works whatever anyone watches, and their fused objects go to clients all the time. Each source has a
// Feed per sensor for the page's long-poll (/api/frame?session=…), and `epoch` per source increments whenever its
// sequence is not continuous (seek, step back, loop wrap) so the page can reset its per-beam history.
import { rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { defaultConfig, type Config } from "@mrs6000/processing/config/config";
import type { ClockState } from "./clock";
import { NotFoundError, ValueError } from "./errors";
import { Feed, type Meta } from "./feed";
import { encodeFrame, scanMeta } from "./frames";
import { log } from "./log";
import type { Scan } from "./model";
import type { PlayerState } from "./player";
import type { Header } from "./recording/format";
import type { RecorderState } from "./recording/recorder";
import { Session, SessionRecorder, SESSION_FILE } from "./recording/session";
import { ReplaySession, type ReplayFrame, type SessionInfo } from "./replay";
import { mergeRig, rigFor, saveJson, type Rig } from "./rig";
import type { SensorFrame } from "./sensor/core";
import type { RunnerInput } from "./sensor/runner";
import { SensorSet, type ObjectsTick } from "./sensorSet";
import { BatchJob } from "./batch";
import { Calibration } from "./calibration";
import type { CalibratorOptions } from "@mrs6000/processing/fusion/calib/calibrator";
import { dropCache } from "./trackCache";

/** one configured sensor: where its scans come from, and what its worker and status poll report about it */
export class LiveSensor {
  label = "sensor";                          // prefix of its error messages
  error = "";
  rate = 0;
  clock: ClockState = { offset_s: 0, drift_ppm: 0, samples: 0, resets: 0 };
  readonly input: RunnerInput;
  onUpsideDown: ((v: boolean | null) => void) | null = null;
  private _status: Record<string, unknown> = {};
  /** `source`: a CoLa address, or (tests) a scan generator */
  constructor(readonly name: string, source: (() => AsyncIterable<Scan>) | RunnerInput, readonly ip = "") {
    this.input = typeof source === "function" ? { kind: "scans", source } : source;
  }
  /** latest REST device values (status.ts) */
  get status(): Record<string, unknown> { return this._status; }
  set status(s: Record<string, unknown>) {
    const before = this.upsideDown;
    this._status = s;
    if (this.upsideDown !== before) this.onUpsideDown?.(this.upsideDown);
  }
  get upsideDown(): boolean | null { const v = this._status.UpsideDown; return typeof v === "boolean" ? v : null; }
}

export interface HubState {
  source: "live" | "replay"; session: string | null; default_session: string | null; epoch: number; replay: PlayerState; recording: RecorderState;
  live_error: string; replay_error: string; sensor: boolean; sensors: string[];
}

let epochs = 0;                              // epochs are unique across sources: a page switching sources resets too

/** a source's sensors: their feeds for the page, and the epoch of what they publish */
class Feeds {
  epoch = ++epochs;
  private feeds = new Map<string, Feed>();
  feed(name: string): Feed {
    let f = this.feeds.get(name);
    if (!f) this.feeds.set(name, (f = new Feed()));
    return f;
  }
}

/** frame events of the sources, for the WebSocket clients (ws.ts) */
export interface SourceEvents {
  liveFrame?(sensor: string, f: SensorFrame): void;
  liveObjects?(tick: ObjectsTick): void;
  sessionFrame?(s: ReplaySession, f: ReplayFrame): void;
  sessionObjects?(s: ReplaySession, tick: ObjectsTick): void;
  sessionState?(s: ReplaySession): void;
  sessionClosed?(s: ReplaySession): void;
}

export class Hub {
  live: LiveSensor[];
  rig: Rig;
  cfg: Config;
  liveSet: SensorSet | null = null;          // the live sensors' processing (started by start())
  readonly sessions = new Map<string, ReplaySession>();
  readonly jobs = new Map<string, BatchJob>();   // recordings whose tracks are being computed (by path)
  calibration: Calibration | null = null;     // one at a time
  readonly recorder: SessionRecorder;
  events: SourceEvents = {};
  maxProcessing = 2;                         // replay sessions with their own processing at once
  defaultSession: string | null = null;      // started with --replay: what a page shows unless told otherwise
  private liveFeeds = new Feeds();
  private sessionFeeds = new Map<string, Feeds>();
  private liveSeq: number[] = [];
  private elevCache = new Map<Header, Float32Array>();

  constructor(readonly recDir: string, sensors: LiveSensor[] = [], readonly retryS = 3, rig: Rig | null = null,
              private saveRig: ((rig: Rig) => void) | string | null = null, cfg: Config = defaultConfig()) {
    this.live = sensors;
    for (const s of this.live) if (this.live.length > 1) s.label = `sensor ${s.name}`;
    this.rig = rig ?? { sensors: [] };
    this.cfg = cfg;
    this.recorder = new SessionRecorder(recDir, () => rigFor(this.rig, this.liveNames()));
  }

  // --- lifecycle ---
  start(): void {
    if (!this.live.length) return;
    this.liveSeq = this.live.map(() => 0);
    this.liveSet = new SensorSet(this.live.map(s => ({ name: s.name, input: s.input, label: s.label })), this.cfg, {
      frame: (k, f) => this.liveFrame(k, f),
      status: (k, st) => { const s = this.live[k]; s.error = st.error; s.rate = st.rate; s.clock = st.clock; },
      error: msg => log(msg),
      objects: tick => this.events.liveObjects?.(tick),
    }, { retryS: this.retryS, upsideDown: () => null });
    this.live.forEach((s, k) => {
      s.onUpsideDown = v => this.liveSet?.runners[k].setUpsideDown(v);
      s.onUpsideDown(s.upsideDown);
    });
    this.liveSet.setRig(this.rig);
  }

  /** other live sensors (the registry changed): their workers are replaced; refused while recording */
  setLive(sensors: LiveSensor[]): void {
    if (this.recorder.active) throw new ValueError("stop the recording first");
    this.liveSet?.close();
    this.liveSet = null;
    this.live = sensors;
    for (const s of this.live) s.label = this.live.length > 1 ? `sensor ${s.name}` : "sensor";
    this.liveFeeds = new Feeds();
    this.start();
  }

  async shutdown(): Promise<void> {
    for (const j of this.jobs.values()) j.cancel();
    this.stopCalibration();
    this.liveSet?.close();
    for (const s of [...this.sessions.values()]) this.closeSession(s.id);
    await this.recorder.stop();
  }

  setConfig(cfg: Config): void {
    this.cfg = cfg;
    this.liveSet?.setConfig(cfg);
    for (const s of this.sessions.values()) s.setConfig(cfg);
  }

  // --- sources ---
  liveNames(): string[] { return this.live.map(s => s.name); }

  session(id: string): ReplaySession {
    const s = this.sessions.get(id);
    if (!s) throw new NotFoundError(`session ${id}`);
    return s;
  }

  /** a source's sensors, in rig order (the first is the default for /api/frame): the live ones, or a session's */
  sensors(session: string | null = null): string[] {
    if (session !== null) return this.session(session).sensors;
    return this.live.length ? this.liveNames() : ["sensor"];
  }

  /** a sensor's feed of a source (its first sensor when `name` is null) */
  feed(name: string | null = null, session: string | null = null): Feed {
    const feeds = session === null ? this.liveFeeds : this.sessionFeeds.get(this.session(session).id)!;
    return feeds.feed(name ?? this.sensors(session)[0]);
  }

  liveSensor(name: string | null = null): LiveSensor | null {
    if (name === null) return this.live[0] ?? null;
    return this.live.find(s => s.name === name) ?? null;
  }

  // --- live sensors ---
  /** a live sensor's scan (from its worker): recorded, published */
  private liveFrame(k: number, f: SensorFrame): void {
    const s = this.live[k];
    this.recorder.writeFrame(s.name, f, () => f.hdr);
    this.publish(this.liveFeeds, s.name, f, f.hdr, f.rate, this.liveSeq[k]++, { source: "live", upside_down: f.hdr.upside_down ?? null });
    this.events.liveFrame?.(s.name, f);
  }

  private publish(feeds: Feeds, sensor: string, f: { t: number; d: Uint16Array; r: Uint16Array }, hdr: Header, rate: number, id: number, extra: Meta): void {
    let elev = this.elevCache.get(hdr);
    if (!elev) { if (this.elevCache.size > 16) this.elevCache.clear(); this.elevCache.set(hdr, (elev = Float32Array.from(hdr.elev))); }
    const { data, points } = encodeFrame(f, hdr, elev);
    const meta: Meta = { ...scanMeta(points, hdr.layers, hdr.beams, hdr.start_azimuth_deg, hdr.step_deg, rate, f.t), ...extra,
                         epoch: feeds.epoch, sensor, scan: id };
    feeds.feed(sensor).publish(data, meta);
  }

  // --- replay sessions ---
  /** a new replay session of a recording; its processing (objects clients) starts on demand, see setProcessing */
  createSession(path: string): ReplaySession {
    const feeds = new Feeds();
    let lastEpoch = 0;
    const s: ReplaySession = new ReplaySession(path, this.cfg, {
      frame: f => {
        if (f.epoch !== lastEpoch) { feeds.epoch = ++epochs; lastEpoch = f.epoch; }
        this.publish(feeds, f.sensor, f.frame, f.hdr, f.rate, f.k, { source: "replay", session: s.id, upside_down: f.hdr.upside_down ?? null, replay: s.player.state() });
        this.events.sessionFrame?.(s, f);
      },
      state: () => this.events.sessionState?.(s),
    });
    this.sessions.set(s.id, s);
    this.sessionFeeds.set(s.id, feeds);
    log(`session ${s.id}: replaying ${s.name}`);
    return s;
  }

  /** a session's objects on or off (objects clients): from the track cache if it has them, else its own processing,
   *  which is refused past the limit, so live never slows down */
  setObjects(id: string, on: boolean): void {
    const s = this.session(id), emit = (tick: ObjectsTick) => this.events.sessionObjects?.(s, tick);
    if (!on) { s.stopObjects(); return; }
    if (s.objects) return;
    if (s.hasCache()) { s.startObjects("cache", emit); return; }
    this.checkLimit();
    s.startObjects("processing", emit);
  }

  /** replays with their own processing and background jobs together stay within the limit */
  private checkLimit(): void {
    const n = [...this.sessions.values()].filter(x => x.processing).length + [...this.jobs.values()].filter(j => j.running).length;
    if (n >= this.maxProcessing) throw new ValueError(`at most ${this.maxProcessing} replays with processing at once`);
  }

  // --- calibration (calibration.ts) ---
  /** calibrate the live sensors, or a replay session's (it processes meanwhile) */
  startCalibration(session: string | null = null, o: CalibratorOptions = {}): Calibration {
    this.calibration?.close();
    let set: SensorSet | null;
    if (session === null) set = this.liveSet;
    else {
      const s = this.session(session);
      if (!s.processing) { this.checkLimit(); s.startObjects("processing", tick => this.events.sessionObjects?.(s, tick)); }
      set = s.sensorSet;
    }
    if (!set) throw new ValueError("no sensors to calibrate");
    if (set.names.length < 2) throw new ValueError("calibration needs at least two sensors");
    this.calibration = new Calibration(session ?? "live", set, o);
    return this.calibration;
  }

  /** store the calibration's poses as the rig (of the live sensors or the session's recording) */
  acceptCalibration(): Rig {
    const c = this.calibration;
    if (!c?.result) throw new ValueError("no calibration result to accept");
    const target = c.target === "live" ? null : c.target, sensors = c.entries();   // before close(): it cancels the calibrator
    c.close();
    this.calibration = null;
    return this.setRig({ sensors }, target);
  }

  stopCalibration(): void { this.calibration?.close(); this.calibration = null; }

  /** compute a recording's tracks in the background into the track cache (batch.ts) */
  processRecording(path: string): BatchJob {
    const running = this.jobs.get(path);
    if (running?.running) return running;
    this.checkLimit();
    const job = new BatchJob(path, this.cfg);
    this.jobs.set(path, job);
    return job;
  }

  closeSession(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (this.calibration?.target === id) this.stopCalibration();
    s.close();
    this.sessions.delete(id);
    if (this.defaultSession === id) this.defaultSession = null;
    this.sessionFeeds.delete(id);
    this.events.sessionClosed?.(s);
    log(`session ${id}: closed`);
  }

  sessionInfo(): SessionInfo[] { return [...this.sessions.values()].map(s => s.info()); }

  // --- recording ---
  startRecording(path: string | null = null): Promise<string> {
    if (!this.live.length) throw new ValueError("no sensor connected (offline mode)");
    return this.recorder.start(this.liveNames(), path);
  }

  stopRecording(): Promise<void> { return this.recorder.stop(); }

  /** delete a recording (file or session folder): refused while it is being recorded; its replays end first */
  deleteRecording(path: string): void {
    const rs = this.recorder.state();
    if (rs.active && rs.file === basename(path) && this.recorder.path && resolve(this.recorder.path) === resolve(path)) throw new ValueError("stop the recording first");
    if (this.jobs.get(path)?.running) throw new ValueError("its tracks are being computed; try again in a moment");
    for (const s of [...this.sessions.values()]) if (resolve(s.path) === resolve(path)) this.closeSession(s.id);
    rmSync(path, { recursive: statSync(path).isDirectory(), force: true });
    dropCache(path);
  }

  // --- the rig (sensor poses) ---
  /** poses of a source's sensors: the live rig, or the session's recording's own */
  currentRig(session: string | null = null): Rig {
    return session === null ? rigFor(this.rig, this.sensors()) : this.session(session).rig;
  }

  /** store calibration results: the live rig, or the session folder being replayed */
  setRig(update: unknown, session: string | null = null): Rig {
    const names = new Set(this.sensors(session)), items = (update as { sensors?: unknown })?.sensors;
    if (Array.isArray(items) && items.some(u => !u || typeof u !== "object" || !names.has((u as { name?: string }).name ?? "")))
      throw new ValueError(`unknown sensor (the current ones: ${[...names].sort().join(", ")})`);
    if (session !== null) {
      const s = this.session(session), rec = s.rec;
      if (!(rec instanceof Session)) throw new ValueError("a single-sensor recording has no rig to store");
      rec.meta.rig = mergeRig(rec.meta.rig ?? { sensors: [] }, update);
      saveJson(join(rec.path, SESSION_FILE), rec.meta);
      s.rigChanged();
    } else {
      this.rig = mergeRig(this.rig, update);
      if (typeof this.saveRig === "string") saveJson(this.saveRig, this.rig); else this.saveRig?.(this.rig);
      this.liveSet?.setRig(this.rig);
    }
    return this.currentRig(session);
  }

  // --- state ---
  liveError(): string { return this.live.filter(s => s.error).map(s => s.error).join("; "); }

  /** a source's sensors: name, and for live ones their address, error, rate and clock */
  sensorInfo(session: string | null = null): ({ name: string; live: boolean } & Partial<{ ip: string; error: string; rate: number; clock: ClockState; device: unknown; upside_down: unknown }>)[] {
    return this.sensors(session).map(name => {
      const s = session === null ? this.liveSensor(name) : null;
      return s ? { name, live: true, ip: s.ip, error: s.error, rate: Math.round(s.rate * 100) / 100, clock: s.clock,
                   device: s.status.DeviceType ?? null, upside_down: s.status.UpsideDown ?? null }
               : { name, live: false };
    });
  }

  state(session: string | null = null): HubState {
    const s = session === null ? null : this.session(session);
    return { source: s ? "replay" : "live", session: s?.id ?? null, default_session: this.defaultSession, epoch: s ? this.sessionFeeds.get(s.id)!.epoch : this.liveFeeds.epoch,
             replay: s?.player.state() ?? {}, recording: this.recorder.state(), live_error: this.liveError(), replay_error: s?.error ?? "",
             sensor: this.live.length > 0, sensors: this.sensors(session) };
  }
}
