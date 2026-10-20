// One sensor of the rig as the page holds it: its frame stream, its own Processor (the whole pipeline runs
// per sensor, on its own range image, in its own worker: pipeline/host.ts), its Geometry, and its pose in the
// world (rig.json). The composition
// root (app.ts) keeps one per sensor of the current source; a single sensor is a rig of one at the origin.
import { ApiError, type Api, type Frame } from "./api/client";
import { FrameStream, type StreamHealth } from "./api/stream";
import type { Config } from "./config/config";
import { KEYS, type Store } from "./config/storage";
import type { FrameMeta, Mount, RigSensor } from "./core/types";
import { fromParams, IDENTITY, type Pose } from "./fusion/pose";
import type { Observation } from "./fusion/objects";
import type { SurfaceMerge } from "./fusion/surfaces";
import { ProcessorHost, type HostEvents } from "./pipeline/host";
import type { Geometry } from "./render/geometry";

export class SensorView {
  readonly processor: ProcessorHost;
  readonly stream: FrameStream;
  geo: Geometry | null = null;
  pose: Pose = IDENTITY;
  timeOffset = 0;                  // s, added to its scan times (rig.json, from calibration)
  calibrated = "";                 // when, "" = never
  visible = true;
  lastEpoch: number | null = null;
  meta: FrameMeta | null = null;
  ts = 0;                          // its last scan's time on the shared clock, with timeOffset
  frameAt = 0;                     // performance.now() of its last frame
  obs: Observation[] = [];         // its tracked objects in the world, for the fusion
  merge: SurfaceMerge | null = null;   // where its static surfaces are shared with other sensors

  constructor(readonly name: string, readonly index: number, cfg: Config, mount: Mount, private store: Store,
              api: Api, onFrame: (v: SensorView, f: Frame) => void, health: StreamHealth, multi: boolean, events: HostEvents) {
    this.processor = new ProcessorHost(cfg, mount, events);
    const bias = store.json<number[]>(this.biasKey);
    if (Array.isArray(bias)) this.processor.setLayerBias(bias);
    // a stream asks for its sensor by name only in a rig: a single sensor's default needs none, so a source
    // switch never leaves it asking for a name that is gone. A sensor that is gone answers 404 until the
    // page drops its view (next state poll): not a server problem.
    const quiet: StreamHealth = { ok: () => health.ok(), fail: e => { if (!(e instanceof ApiError && e.status === 404)) health.fail(e); } };
    this.stream = new FrameStream(api, f => onFrame(this, f), quiet, undefined, multi ? name : undefined);
  }

  /** layer calibration is the device's own: one stored set per sensor name */
  get biasKey(): string { return this.name === "sensor" ? KEYS.layerBias : `${KEYS.layerBias}.${this.name}`; }

  saveBias(): void { this.store.setJson(this.biasKey, Array.from(this.processor.layerBias)); }

  /** its rig.json entry: pose, time offset (none: at the origin) */
  setRig(r: RigSensor | undefined): void {
    this.pose = r?.pose ? fromParams(r.pose) : IDENTITY;
    this.timeOffset = r?.time_offset_s ?? 0;
    this.calibrated = r?.calibrated ?? "";
  }

  start(): void { void this.stream.run(); }
  stop(): void { this.stream.stop(); this.processor.dispose(); }
}
