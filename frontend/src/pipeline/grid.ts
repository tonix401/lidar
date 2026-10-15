// The scan as an organized range image: L layers (rows, bottom→top) × B beams (columns, right→left).
// Index i = layer * B + beam. All per-beam state of the pipeline lives here: the scan itself and its buffers
// below, plus each stage's own state, declared in its module (beamState.ts) and listed in STATES.
import { beamState, type StateFields } from "./beamState";
import { historyState } from "./history";
import { motionState } from "./motion";
import { outlineState } from "./outline";
import { planesState } from "./planes";
import { rayState } from "./rays";
import { temporalState } from "./temporal";
import { wallState } from "./wall";

/** the scan and the buffers the stages pass ranges through */
const scanState = beamState({
  rawIn: Float32Array,          // ranges as received (m, 0 = no return)
  raw: Float32Array,            // after intensity filter, layer calibration and outlier rejection
  rssi: Float32Array, elev: Float32Array,
  work: Float32Array, out: Float32Array,                        // scratch + final ranges
  queue: Int32Array, mark: Uint8Array,                          // BFS scratch
}, { reset: false });

const STATES = [scanState, rayState, temporalState, motionState, historyState, planesState, wallState, outlineState];

export type Grid = { L: number; B: number; N: number; frames: number; raysReady: boolean } &
  StateFields<typeof scanState> & StateFields<typeof rayState> & StateFields<typeof temporalState> &
  StateFields<typeof motionState> & StateFields<typeof historyState> & StateFields<typeof planesState> &
  StateFields<typeof wallState> & StateFields<typeof outlineState>;

export function createGrid(L: number, B: number): Grid {
  const N = L * B, g: Record<string, unknown> = { L, B, N, frames: 0, raysReady: false };
  for (const s of STATES) for (const [k, Ctor] of Object.entries(s.fields)) g[k] = new Ctor(N);
  return g as Grid;
}

/** forget all per-beam history (after a seek, preset change, ...) */
export function resetHistory(g: Grid): void {
  for (const s of STATES) if (s.reset) for (const k of Object.keys(s.fields)) (g as unknown as Record<string, Uint8Array>)[k].fill(0);
  g.frames = 0;
}

/** each field is declared by exactly one state (for the tests) */
export const gridFieldOwners = (): string[] => STATES.flatMap(s => Object.keys(s.fields));
