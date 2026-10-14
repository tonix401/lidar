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
  let n = 0;
  const near = (i: number): number => {                       // nearest background around beam i (0 = none)
    if (!dims) return m.bg[i];
    const { L, B } = dims, l = (i / B) | 0, b0 = i - l * B;
    let best = 0;
    for (let ll = Math.max(0, l - 1); ll <= Math.min(L - 1, l + 1); ll++)
      for (let bb = Math.max(0, b0 - 1); bb <= Math.min(B - 1, b0 + 1); bb++) {
        const v = m.bg[ll * B + bb];
        if (v > 0 && (best === 0 || v < best)) best = v;
      }
    return best;
  };
  for (let i = 0; i < cur.length; i++) {
    const z = cur[i], b = z > 0 ? near(i) : 0;
    const fg = z > 0 && ((b <= 0 || z < b - fgTol(c, noiseVar[i], b)) || (c.scope === 1 && area[i] === 1));
    out[i] = fg ? 1 : 0;
    n += out[i];
  }
  return n;
}
