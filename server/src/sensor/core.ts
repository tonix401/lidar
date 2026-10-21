// One sensor's processing on the server: frames in (from its CoLa connection, or replayed from a recording),
// objects out. The same code runs inside the sensor's worker (worker.ts) and, without workers, on the main thread
// (runner.ts). Only the ingest phase of the pipeline runs (Processor.ingest(…, display = false)): what object
// detection needs, about a fifth of the work; the page runs the display stages itself.
import { defaultConfig, type Config } from "@mrs6000/processing/config/config";
import type { FrameMeta, Mount } from "@mrs6000/processing/core/types";
import { observe, type Observation } from "@mrs6000/processing/fusion/objects";
import { IDENTITY, type Pose } from "@mrs6000/processing/fusion/pose";
import type { OtherSensor } from "@mrs6000/processing/pipeline/crosscheck";
import { Processor } from "@mrs6000/processing/pipeline/processor";
import type { FrameStats } from "@mrs6000/processing/pipeline/steps";
import { DeviceClock, scanTime, type ClockState } from "../clock";
import { Health, type Stop } from "../health";
import { nowS } from "../log";
import type { Scan } from "../model";
import { DIST_UNIT_MM, frameValues, headerOf, type Frame, type Header } from "../recording/format";

/** a sensor's scan as it travels on the server: as recorded (uint16 distances, rssi) with its layout */
export interface SensorFrame extends Frame { hdr: Header; rate: number; seq: number }

/** a confirmed track of one sensor, in its own frame (calibration records the walker's detections) */
export interface TrackSummary { id: number; moved: boolean; static: boolean; det: { x: number; y: number; z: number } | null }

/** what a processed scan gives the rest of the server */
export interface SensorOutput {
  seq: number; t: number;
  observations: Observation[];     // its tracked objects in the world, for the fusion
  tracks: TrackSummary[];
  raw: Float32Array;               // its filtered scan: what the other sensors' cross-check compares with
  bgReady: boolean;
  stats: FrameStats;
}

/** a sensor's live connection state */
export interface SensorStatus { error: string; rate: number; clock: ClockState }

/** what the calibration solve needs of a sensor: its rays and its empty scene */
export interface CalibData { L: number; B: number; rayX: Float32Array; rayY: Float32Array; rayZ: Float32Array; bg: Float32Array }

/** another sensor's latest filtered scan for the cross-check; its age is set when this sensor's scan is processed */
export type OtherScan = OtherSensor & { scanT: number };

/** another sensor's scan older than this (s, on the shared clock) is not cross-checked against: it has gone quiet */
export const OTHER_MAX_AGE_S = 0.5;

export type MountSetting = Mount | "auto";      // auto: follow the device (UpsideDown) or the recording's header

export class SensorCore {
  readonly processor: Processor;
  pose: Pose = IDENTITY;
  private others = new Map<number, OtherScan>();   // the other sensors' latest scans, by their index
  private elev: Float32Array | null = null;
  private data = new Float32Array(0);              // the pipeline's input, reused
  private elevOf: number[] | null = null;

  constructor(readonly name: string, readonly index: number, cfg: Config = defaultConfig(), public mount: MountSetting = "auto") {
    this.processor = new Processor(cfg, mount === "auto" ? "upright" : mount);
  }

  set cfg(c: Config) { this.processor.cfg = c; }

  /** sensor `k`'s latest scan for the cross-check (null: forget it) */
  setOther(k: number, o: OtherScan | null): void { if (o) this.others.set(k, o); else this.others.delete(k); }

  /** the pipeline on one scan; its outputs for the fusion, the calibration and the other sensors */
  process(f: SensorFrame): SensorOutput {
    const { hdr } = f, L = hdr.layers, B = hdr.beams, N = L * B, p = this.processor;
    const want: Mount = this.mount !== "auto" ? this.mount : hdr.upside_down ? "upsidedown" : "upright";
    if (want !== p.mount) p.setMount(want);
    if (this.elevOf !== hdr.elev) { this.elev = Float32Array.from(hdr.elev); this.elevOf = hdr.elev; }
    if (this.data.length !== 3 * N) this.data = new Float32Array(3 * N);
    const data = this.data;
    let points = 0;
    for (let i = 0; i < N; i++) { data[i] = f.d[i] * (DIST_UNIT_MM / 1000); if (f.d[i]) points++; }
    data.set(f.r, N);
    data.set(this.elev!, 2 * N);
    const meta: FrameMeta = { id: f.seq, points, layers: L, beams: B, start_azimuth_deg: hdr.start_azimuth_deg, step_deg: hdr.step_deg,
                              rate: f.rate, scan_frequency_hz: 10, ts: f.t };
    const others: OtherScan[] = [];
    for (const o of this.others.values()) {
      o.age = f.t - o.scanT;                                    // s between its scan and this one
      if (Math.abs(o.age) <= OTHER_MAX_AGE_S) others.push(o);
    }
    p.others = others;
    const g = p.ingest(data, meta, false), det = p.objects!;
    const on = p.cfg.objects.on;
    return {
      seq: f.seq, t: f.t, observations: on ? observe(this.index, this.pose, f.t, det, g) : [],
      tracks: on ? det.confirmed.map(t => ({ id: t.id, moved: t.moved, static: t.static, det: t.det ? { x: t.det.x, y: t.det.y, z: t.det.z } : null })) : [],
      raw: Float32Array.from(g.raw), bgReady: det.bgModel.ready, stats: { ...p.stats },
    };
  }

  calibData(): CalibData | null {
    const g = this.processor.grid, bg = this.processor.objects?.bgModel;
    if (!g || !bg?.ready) return null;
    return { L: g.L, B: g.B, rayX: Float32Array.from(g.rayX), rayY: Float32Array.from(g.rayY), rayZ: Float32Array.from(g.rayZ), bg: Float32Array.from(bg.bg) };
  }

  reset(): void { this.processor.reset(); }
}

/** does `hdr` still describe this scan (layer count, beams, azimuths, every elevation, mount)? */
function sameLayout(hdr: Header | null, scan: Scan, upsideDown: boolean | null): boolean {
  if (!hdr || hdr.layers !== scan.layers.length || (hdr.upside_down ?? null) !== upsideDown) return false;
  const B = hdr.beams, l0 = scan.layers[0];
  if (l0.echoes[0].distanceMm.length !== B || l0.startAzimuthDeg !== hdr.start_azimuth_deg || l0.stepDeg !== hdr.step_deg) return false;
  for (let l = 0; l < scan.layers.length; l++) {
    const layer = scan.layers[l], e = layer.beamElevationDeg;
    for (let b = 0; b < B; b++) if ((e ? e[b] : layer.elevationDeg) !== hdr.elev[l * B + b]) return false;
  }
  return true;
}

/** A live sensor's loop: connect, stream, and on any failure (sensor off, unplugged, timeout, bad telegram) report
 *  one short line and reconnect every retryS seconds. Each scan becomes a SensorFrame on the shared clock. */
export async function liveLoop(name: string, source: () => AsyncIterable<Scan>, stop: Stop, retryS: number,
                               upsideDown: () => boolean | null, emit: (f: SensorFrame) => void,
                               status: (s: SensorStatus) => void, label = name): Promise<void> {
  const clock = new DeviceClock(), health = new Health(`${label} (CoLa)`, retryS);
  let seq = 0, rate = 0, error = "", hdr: Header | null = null;
  const report = () => status({ error, rate, clock: clock.state() });
  while (!stop.isSet) {
    try {
      let last = nowS();
      for await (const scan of source()) {
        if (stop.isSet) return;
        const now = nowS();
        if (health.error) { health.ok(); error = ""; }
        const t = scanTime(clock, scan, now), { d, r } = frameValues(scan);
        rate = 1 / Math.max(now - last, 1e-3);
        last = now;
        hdr = sameLayout(hdr, scan, upsideDown()) ? hdr : headerOf(scan, upsideDown(), name);   // one header while the layout stays
        emit({ t, d, r, hdr: hdr!, rate, seq: seq++ });
        if (seq % 10 === 1) report();
      }
      error = `${label}: ` + health.fail("stream ended");
    } catch (e) {
      error = `${label}: ` + health.fail(e);
    }
    rate = 0;
    report();
    await stop.wait(retryS);
  }
}
