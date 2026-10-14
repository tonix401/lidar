// The scan as an organized range image: L layers (rows, bottom→top) × B beams (columns, right→left).
// Index i = layer * B + beam. All per-beam state of the pipeline lives here.

export interface Grid {
  L: number; B: number; N: number;
  rawIn: Float32Array;          // ranges as received (m, 0 = no return)
  raw: Float32Array;            // after intensity filter, layer calibration and outlier rejection
  rssi: Float32Array; elev: Float32Array;
  // temporal model per beam: estimate, samples in the average, learned noise variance, pending change
  // candidate, dropout age, validity bits of the last 32 scans, jump rate, second background mode
  temporal: Float32Array; nAvg: Uint16Array; noiseVar: Float32Array;
  cand: Float32Array; candCnt: Uint8Array; age: Uint8Array;
  validBits: Uint32Array; jumpRate: Float32Array; frames: number;
  alt: Float32Array; altN: Uint16Array;
  hist: Float32Array; conf: Float32Array;                       // history-filtered ranges + confidence weights
  changed: Uint8Array; motionHold: Uint8Array;                  // adaptive: per-scan change flags, scans left "moving"
  area: Uint8Array;                                             // 0 static flat · 1 static detail · 2 moving
  work: Float32Array; out: Float32Array;                        // scratch + final ranges
  wall: Float32Array; wallN: Uint8Array; fill: Float32Array;   // remembered static range (+ readings); drawn behind objects
  wallCand: Float32Array; wallCandN: Uint8Array;                // a new static surface, until confirmed
  front: Uint8Array;                                            // in front of the empty scene (objects), for the mesh
  seesWall: Uint8Array;                                         // the return matches the remembered wall (or none known)
  rayX: Float32Array; rayY: Float32Array; rayZ: Float32Array; raysReady: boolean;
  queue: Int32Array; mark: Uint8Array;                          // BFS scratch
}

export function createGrid(L: number, B: number): Grid {
  const N = L * B, f = () => new Float32Array(N);
  return {
    L, B, N, rawIn: f(), raw: f(), rssi: f(), elev: f(),
    temporal: f(), nAvg: new Uint16Array(N), noiseVar: f(), cand: f(), candCnt: new Uint8Array(N), age: new Uint8Array(N),
    validBits: new Uint32Array(N), jumpRate: f(), frames: 0, alt: f(), altN: new Uint16Array(N),
    hist: f(), conf: f(), changed: new Uint8Array(N), motionHold: new Uint8Array(N), area: new Uint8Array(N),
    work: f(), out: f(), wall: f(), wallN: new Uint8Array(N), fill: f(), wallCand: f(), wallCandN: new Uint8Array(N), front: new Uint8Array(N), seesWall: new Uint8Array(N), rayX: f(), rayY: f(), rayZ: f(), raysReady: false,
    queue: new Int32Array(N), mark: new Uint8Array(N),
  };
}

/** forget all per-beam history (after a seek, preset change, ...) */
export function resetHistory(g: Grid): void {
  for (const a of [g.temporal, g.nAvg, g.noiseVar, g.cand, g.candCnt, g.age, g.validBits, g.jumpRate, g.alt, g.altN,
                   g.changed, g.motionHold, g.area, g.wall, g.wallN, g.fill, g.wallCand, g.wallCandN, g.front, g.seesWall]) a.fill(0);
  g.frames = 0;
}
