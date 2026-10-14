// Remembered walls: a person in front of a wall hides it (each beam returns one range), so the wall shows a
// person-shaped hole ("shadow") that walks along with them. Each beam remembers its last static output range
// (smoothed, flattened: exactly how the wall looked), and where something is in front of it — a moving
// beam, or any return in front of the object detector's empty-scene background (also a person standing
// still, until the background adopts them after `learn` s) — or a moving beam lost its return, that range is
// drawn as well (geometry.ts: a second vertex per beam).
// Only surfaces that belong to the empty scene are remembered (not in front of the object detector's
// background), so a person who stood still for a moment does not leave a ghost behind once they walk on.
// That background starts as the first scan and only learns within 0.3 s that a wall is behind whatever
// stood there; a remembered surface that turns out to be in front of it is replaced by it.
import type { Config } from "../config/config";
import { sameTol } from "../core/math";
import { fgTol } from "../objects/background";
import type { Grid } from "./grid";
import { isMoving } from "./motion";

/** remember the static surfaces of output `D` in g.wall */
export function updateWall(g: Grid, D: Float32Array, bg: Float32Array | null, cfg: Config): void {
  const { wall, noiseVar } = g;
  for (let i = 0; i < g.N; i++) {
    const d = D[i], b = bg ? bg[i] : 0, front = b > 0 ? b - fgTol(cfg.objects, noiseVar[i], b) : 0;
    if (wall[i] > 0 && wall[i] < front) wall[i] = b;          // remembered something that has gone since
    if (d <= 0 || isMoving(g, i, cfg) || d < front) continue; // nothing, moving, or in front of the empty scene
    wall[i] = d;
  }
}

/** ranges to draw behind objects (0 = none) into `out`; returns how many beams got one */
export function wallFill(g: Grid, D: Float32Array, bg: Float32Array | null, cfg: Config, out: Float32Array): number {
  const { wall, noiseVar } = g;
  let n = 0;
  for (let i = 0; i < g.N; i++) {
    const w = wall[i], d = D[i], b = bg ? bg[i] : 0, moving = isMoving(g, i, cfg);
    const object = moving || (d > 0 && b > 0 && d < b - fgTol(cfg.objects, noiseVar[i], b));
    out[i] = w > 0 && object && (d <= 0 ? moving : d < w - sameTol(w, 0.15, 0.03)) ? w : 0;
    if (out[i]) n++;
  }
  return n;
}
