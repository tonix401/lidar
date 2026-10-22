// Slow background: per beam the range of the empty scene. Unlike the smoothing model, which follows a
// change within a few scans, it only adopts a *nearer* surface after `learn` s of stability (a farther
// one — something that stood in front went away — within 0.3 s), and never under a held (tracked)
// object, so a person standing still does not melt into the background. 0 = "no return" background.
import type { Config } from "../config/config";

export interface Background {
  bg: Float32Array;        // empty-scene range (0 = no return)
  cand: Float32Array;      // candidate replacement
  stable: Float32Array;    // seconds the candidate has been stable
  ready: boolean;
}

export const createBackground = (N: number): Background =>
  ({ bg: new Float32Array(N), cand: new Float32Array(N), stable: new Float32Array(N), ready: false });

export const REVEAL_S = 0.3;

/** distance a return must be in front of the background to count as foreground */
export const fgTol = (c: Config["objects"], noiseVar: number, d: number): number => c.minDiff + 3 * Math.sqrt(noiseVar) + 0.01 * d;

export function updateBackground(m: Background, cur: Float32Array, noiseVar: Float32Array, hold: Uint8Array,
                                 dt: number, c: Config["objects"]): void {
  const { bg, cand, stable } = m;
  if (!m.ready) { bg.set(cur); stable.fill(0); m.ready = true; return; }
  for (let i = 0; i < cur.length; i++) {
    const z = cur[i], b = bg[i], tol = fgTol(c, noiseVar[i], Math.max(z, b));
    const same = (u: number, v: number) => (u <= 0 && v <= 0) || (u > 0 && v > 0 && Math.abs(u - v) <= tol);
    if (same(z, b)) { if (z > 0) bg[i] = b + 0.05 * (z - b); stable[i] = 0; continue; }
    if (same(z, cand[i])) stable[i] += dt; else { cand[i] = z; stable[i] = dt; }
    const need = b > 0 && z > b ? REVEAL_S : c.learn;
    if (stable[i] >= need && !hold[i]) { bg[i] = cand[i]; stable[i] = 0; }
  }
}

/** foreground mask: returns clearly in front of the background (scope 1: also static "detail" areas).
 *  With the grid size (`dims`), the background is the nearest one among the beam and its 8 neighbours
 *  (neighbourhood background): at a static depth edge a beam alternates between the near and the far
 *  surface or returns a mixed range in between, and a real object in front of the edge is in front of both;
 *  and a beam whose own background is "no return" (dark surface, edge, far away) is judged by its
 *  neighbours' instead of counting every sporadic return as foreground. */
export function foreground(m: Background, cur: Float32Array, noiseVar: Float32Array, area: Uint8Array,
                           c: Config["objects"], out: Uint8Array, dims?: { L: number; B: number }): number {
  const near = dims ? nearestAround(m.bg, dims.L, dims.B) : m.bg;   // nearest background around each beam (0 = none)
  let n = 0;
  for (let i = 0; i < cur.length; i++) {
    const z = cur[i], b = z > 0 ? near[i] : 0;
    const fg = z > 0 && ((b <= 0 || z < b - fgTol(c, noiseVar[i], b)) || (c.scope === 1 && area[i] === 1));
    out[i] = fg ? 1 : 0;
    n += out[i];
  }
  return n;
}

let rowMin = new Float32Array(0), around = new Float32Array(0);

/** per beam the nearest return (smallest positive range, 0 = none) among it and its 8 neighbours: along the
 *  layer, then across layers (the minimum is separable). Scratch buffers, valid until the next call. */
function nearestAround(r: Float32Array, L: number, B: number): Float32Array {
  const N = L * B;
  if (rowMin.length < N) { rowMin = new Float32Array(N); around = new Float32Array(N); }
  const lo = (a: number, b: number) => (a > 0 && (b <= 0 || a < b) ? a : b);
  for (let l = 0; l < L; l++) for (let b = 0, i = l * B; b < B; b++, i++)
    rowMin[i] = lo(b > 0 ? r[i - 1] : 0, lo(r[i], b < B - 1 ? r[i + 1] : 0));
  for (let i = 0; i < N; i++)
    around[i] = lo(i >= B ? rowMin[i - B] : 0, lo(rowMin[i], i + B < N ? rowMin[i + B] : 0));
  return around;
}
