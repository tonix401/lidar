// What the page reads of one sensor's processing, as one message from its worker (worker.ts) to the mirror on
// the main thread (host.ts): the grid arrays below, the object detector's per-beam ids, background and tracks,
// the radial cells' slots, the statistics and the layer calibration. The arrays travel packed in one buffer,
// which the page hands back for the next scan (no allocation per scan).
import type { ObjectDetector } from "@mrs6000/processing/objects/detector";
import type { Track } from "@mrs6000/processing/objects/tracker";
import type { Grid } from "@mrs6000/processing/pipeline/grid";
import type { Processor } from "@mrs6000/processing/pipeline/processor";
import type { FrameStats } from "@mrs6000/processing/pipeline/steps";

/** grid arrays the page reads (views, tooltips, auto mode, fusion, calibration); the rest stays in the worker */
export const MIRRORED = ["out", "fill", "front", "seesWall", "wall", "wallN", "raw", "rawIn", "rssi", "area", "conf",
                         "noiseVar", "nAvg", "temporal", "motionHold", "jumpRate", "validBits"] as const satisfies readonly (keyof Grid)[];
/** sent only when they changed (a new grid, another scan geometry or mount) */
export const MIRRORED_RAYS = ["elev", "rayX", "rayY", "rayZ"] as const satisfies readonly (keyof Grid)[];

type Typed = Float32Array | Uint8Array | Uint16Array | Uint32Array | Int32Array;

export interface Snapshot {
  L: number; B: number; frames: number; ts: number;
  buf: ArrayBuffer;
  packed: string[];                // names of the arrays in `buf`, in order (see arrays())
  stats: FrameStats; rssiHist: Uint32Array; layerBias: Float32Array; biasChanged: boolean;
  tracks: Track[]; bgReady: boolean; foregroundCount: number; lastMs: number;
  cells: boolean;                  // radial cells on: their slots are in `buf`
}

/** the arrays of a snapshot by name: the grid's, and "cell", "bg" (object detector), "assign" (radial cells) */
function arrays(g: Grid, det: ObjectDetector, assign: Int32Array | null, rays: boolean): [string, Typed][] {
  const out: [string, Typed][] = MIRRORED.map(k => [k, g[k]]);
  if (rays) for (const k of MIRRORED_RAYS) out.push([k, g[k]]);
  out.push(["cell", det.cell], ["bg", det.bgModel.bg]);
  if (assign) out.push(["assign", assign]);
  return out;
}

/** bytes a snapshot of this grid can need at most (every array, 4-byte aligned) */
export function snapshotBytes(g: Grid): number {
  return [...MIRRORED, ...MIRRORED_RAYS].reduce((s, k) => s + align(g[k].byteLength), 0) + 3 * align(4 * g.N);
}

const align = (n: number) => (n + 3) & ~3;

/** the processor's state after a scan or a refine, packed into `buf` (at least snapshotBytes long) */
export function takeSnapshot(p: Processor, buf: ArrayBuffer, rays: boolean, biasChanged: boolean): Snapshot {
  const g = p.grid!, det = p.objects!, assign = p.cells && p.cfg.cells.on ? p.cells.assign : null, packed: string[] = [];
  const bytes = new Uint8Array(buf);
  let at = 0;
  for (const [name, a] of arrays(g, det, assign, rays)) {
    bytes.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), at);
    at += align(a.byteLength);
    packed.push(name);
  }
  return { L: g.L, B: g.B, frames: g.frames, ts: p.ts, buf, packed, stats: { ...p.stats }, rssiHist: p.rssiHist.slice(),
           layerBias: p.layerBias.slice(), biasChanged, tracks: det.tracks, bgReady: det.bgModel.ready,
           foregroundCount: det.foregroundCount, lastMs: det.lastMs, cells: !!assign };
}

/** copy a snapshot into the page's mirror of the grid and detector (same size); returns the radial cells' slots */
export function applySnapshot(s: Snapshot, g: Grid, det: ObjectDetector, assign: Int32Array | null): Int32Array | null {
  const target = new Map(arrays(g, det, s.cells ? assign ?? new Int32Array(g.N) : null, true));
  let at = 0;
  for (const name of s.packed) {
    const t = target.get(name)!, Ctor = t.constructor as new (b: ArrayBuffer, o: number, n: number) => Typed;
    t.set(new Ctor(s.buf, at, t.length));
    at += align(t.byteLength);
  }
  g.frames = s.frames;
  det.tracker.restore(s.tracks);
  det.bgModel.ready = s.bgReady;
  det.foregroundCount = s.foregroundCount; det.lastMs = s.lastMs;
  return s.cells ? target.get("assign") as Int32Array : null;
}
