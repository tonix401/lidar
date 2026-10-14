// Clean outlines: where a person stands in front of a wall, three things tear the surface:
//  • wall beams the person just uncovered stay "moving" for a while and are processed almost raw, so the
//    wall trails a rough patch behind them → a beam whose return matches its remembered wall (wall.ts)
//    within 3σ is drawn as that wall (and, once per scan, averaged into it while it rests on few readings);
//  • beams at the outline see part of both and return a range in between (mixed pixels), which the mesh
//    joins to the person or the wall as spikes →
//    – person side: a beam in front of the empty scene, on the outline, more than `margin` behind its
//      nearest in-front neighbour is dropped (the remembered wall is drawn there instead);
//    – wall side: a beam next to the outline that is not counted as in front (within the detector's
//      foreground tolerance, up to ~30 cm) but lies more than 3σ in front of its remembered wall is put
//      back onto that wall — we know the wall is there;
//  • the mesh joins person and wall wherever their gap is below its jump threshold → the mask of beams in
//    front of the empty scene (`front`) lets the mesh cut every triangle across the outline (geometry.ts).
// "In front" = in front of the empty scene (the object detector's background, else the remembered wall) by
// the detector's foreground tolerance, or a moving beam more than 3σ in front of its remembered wall (feet
// on the floor, a hand on the wall: closer to it than that tolerance), with at least 2 such neighbours (a
// lone noisy wall beam would cut a hole into the wall). None of this needs a confirmed track.
import type { Config } from "../config/config";
import { fgTol } from "../objects/background";
import type { Grid } from "./grid";
import { isMoving } from "./motion";
import { DROPPED, FRONT, onWall, wallTol } from "./wall";

/** moving beams that see their remembered wall are drawn as it; `learn` (once per scan) averages them into
 *  a memory that rests on few readings. Returns how many. */
export function snapToWall(g: Grid, D: Float32Array, cfg: Config, learn: boolean): number {
  const { wall, wallN } = g;
  let n = 0;
  for (let i = 0; i < g.N; i++) {
    if (!isMoving(g, i, cfg) || !onWall(g, i, D[i], cfg)) continue;
    if (learn && wallN[i] < cfg.walls.n) { wallN[i]++; wall[i] += (D[i] - wall[i]) / wallN[i]; }
    D[i] = wall[i]; n++;
  }
  return n;
}

/** front[i] = FRONT where D is part of something in front of the empty scene (see top) */
export function frontMask(g: Grid, D: Float32Array, bg: Float32Array | null, cfg: Config, front: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < g.N; i++) {
    const d = D[i], b = bg && bg[i] > 0 ? bg[i] : g.wall[i], w = g.wall[i];
    const ahead = d > 0 && ((b > 0 && d < b - fgTol(cfg.objects, g.noiseVar[i], b)) ||
                            (w > 0 && isMoving(g, i, cfg) && d < w - wallTol(g, i, cfg)));
    front[i] = ahead ? FRONT : 0;
  }
  const { L, B } = g, lone: number[] = [];
  for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
    const i = l * B + b;
    if (!front[i]) continue;
    let k = 0;
    for (let ll = Math.max(0, l - 1); ll <= Math.min(L - 1, l + 1); ll++)
      for (let bb = Math.max(0, b - 1); bb <= Math.min(B - 1, b + 1); bb++) if (front[ll * B + bb] === FRONT) k++;
    if (k < 3) lone.push(i); else n++;                         // itself + at least 2 neighbours
  }
  for (const i of lone) front[i] = 0;
  return n;
}

/** fixes mixed pixels at the outlines of `front` (in place): person side dropped (front = DROPPED), wall
 *  side put back onto the remembered wall. Returns how many beams changed. */
export function dropMixed(g: Grid, D: Float32Array, front: Uint8Array, cfg: Config): number {
  const { L, B, wall } = g, margin = cfg.outline.margin, drop: number[] = [], snap: number[] = [];
  for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
    const i = l * B + b, d = D[i];
    if (d <= 0) continue;
    let near = Infinity, outline = false;
    for (let ll = Math.max(0, l - 1); ll <= Math.min(L - 1, l + 1); ll++)
      for (let bb = Math.max(0, b - 1); bb <= Math.min(B - 1, b + 1); bb++) {
        const j = ll * B + bb;
        if (j === i) continue;
        if (front[j] === FRONT) near = Math.min(near, D[j]); else outline = true;
      }
    if (near === Infinity) continue;                           // not next to anything in front
    if (front[i] === FRONT) {
      // on the outline, and well behind the object next to it: between the object and the wall
      if (outline && d - near > margin + 0.02 * d) drop.push(i);
    } else if (wall[i] > 0 && d < wall[i] - wallTol(g, i, cfg)) snap.push(i);   // wall side, pulled towards the object
  }
  for (const i of drop) { D[i] = 0; front[i] = DROPPED; }
  for (const i of snap) D[i] = wall[i];
  return drop.length + snap.length;
}
