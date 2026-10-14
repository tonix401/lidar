// Remembered walls: a person in front of a wall hides it (each beam returns one range), so the wall shows a
// person-shaped hole ("shadow") that walks along with them. Each beam remembers the average of its static
// output ranges (smoothed, flattened: how the wall looks), and where something is in front of it — a moving
// beam, or any return in front of the object detector's empty-scene background (also a person standing
// still, until the background adopts them after `learn` s) — or a moving beam lost its return, that range is
// drawn as well (geometry.ts: a second vertex per beam).
// Only surfaces that belong to the empty scene are remembered (not in front of the object detector's
// background), so a person who stood still for a moment does not leave a ghost behind once they walk on.
// That background starts as the first scan and only learns within 0.3 s that a wall is behind whatever
// stood there; a remembered surface that turns out to be in front of it is replaced by it.
// g.wallN counts the readings averaged into each remembered range (up to cfg.walls.n): static outputs, and also
// moving beams that see the wall (outline.ts). Averaging matters: a beam the person has just left restarts
// its temporal average, so its first static outputs are nearly raw; remembering only the latest one made
// the wall behind people ~3× rougher than the wall itself.
// A remembered wall only changes after a new static surface has been seen cfg.walls.confirm scans in a row
// (g.wallCand), and when drawn, a value that sticks out (beyond 3σ) from its neighbours' memories is replaced by their
// median (single readings at outlines are often mixed pixels: remembering one draws a spike), and a young
// memory (fewer than cfg.walls.n readings, where people keep walking) is averaged with its neighbours' memories
// on the same surface: a plane through their 3D points (weighted by their readings), intersected with its beam.
import type { Config } from "../config/config";
import { sameTol, smallestEigenvector } from "../core/math";
import { fgTol } from "../objects/background";
import type { Grid } from "./grid";
import { isMoving } from "./motion";

/** g.front: 1 = in front of the empty scene, DROPPED = a mixed pixel dropped at an outline (outline.ts) */
export const FRONT = 1, DROPPED = 2;

/** remember the static surfaces of output `D` in g.wall */
export function updateWall(g: Grid, D: Float32Array, bg: Float32Array | null, cfg: Config): void {
  const { wall, wallN, noiseVar } = g;
  for (let i = 0; i < g.N; i++) {
    const d = D[i], b = bg ? bg[i] : 0, front = b > 0 ? b - fgTol(cfg.objects, noiseVar[i], b) : 0;
    if (wall[i] > 0 && wall[i] < front) { wall[i] = b; wallN[i] = 1; }   // remembered something that has gone since
    if (d <= 0 || isMoving(g, i, cfg) || d < front) continue; // nothing, moving, or in front of the empty scene
    if (wall[i] <= 0) { wall[i] = d; wallN[i] = 1; continue; }            // the first surface seen
    if (!onWall(g, i, d, cfg)) {                              // a new surface? only once it stays
      const c = g.wallCand[i];
      if (g.wallCandN[i] > 0 && Math.abs(d - c) <= wallTol(g, i, cfg)) { g.wallCandN[i]++; g.wallCand[i] += (d - c) / g.wallCandN[i]; }
      else { g.wallCand[i] = d; g.wallCandN[i] = 1; }
      if (g.wallCandN[i] >= cfg.walls.confirm) { wall[i] = g.wallCand[i]; wallN[i] = g.wallCandN[i]; g.wallCandN[i] = 0; }
      continue;
    }
    g.wallCandN[i] = 0;
    if (wallN[i] < cfg.walls.n) wallN[i]++;
    wall[i] += (d - wall[i]) / Math.min(wallN[i], cfg.walls.n);   // n may have been lowered
  }
}

/** drop every remembered surface (walls stage switched off) */
export function forgetWalls(g: Grid): void {
  g.wall.fill(0); g.wallN.fill(0); g.wallCandN.fill(0);
}

/** 3σ of a return against beam i's remembered wall (incl. the uncertainty of a young memory) */
export function wallTol(g: Grid, i: number, cfg: Config): number {
  return 3 * Math.sqrt(Math.max(cfg.temporal.noiseFloor ** 2, g.noiseVar[i]) * (1 + 1 / Math.max(1, g.wallN[i])));
}

/** does range d match beam i's remembered wall? */
export function onWall(g: Grid, i: number, d: number, cfg: Config): boolean {
  const w = g.wall[i];
  return w > 0 && d > 0 && Math.abs(d - w) <= wallTol(g, i, cfg);
}

/** ranges to draw behind objects (0 = none) into `out`; returns how many beams got one. With clean outlines
 *  on, also behind everything the mesh is cut around (g.front, outline.ts), so every cut gets its wall,
 *  and behind mixed pixels dropped there (DROPPED). */
export function wallFill(g: Grid, D: Float32Array, bg: Float32Array | null, cfg: Config, out: Float32Array): number {
  const { L, B, wall, noiseVar, front, rayX, rayY, rayZ } = g, nb: number[] = [], nrm = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < g.N; i++) {
    const w = wall[i], d = D[i], b = bg ? bg[i] : 0, moving = isMoving(g, i, cfg);
    const object = moving || (d > 0 && b > 0 && d < b - fgTol(cfg.objects, noiseVar[i], b));
    const ahead = (cfg.outline.on && front[i] === FRONT) || (object && d < w - sameTol(w, 0.15, 0.03));
    g.seesWall[i] = w <= 0 || onWall(g, i, d, cfg) ? 1 : 0;
    out[i] = w > 0 && (d <= 0 ? moving || front[i] === DROPPED : ahead && d < w) ? w : 0;
    if (!out[i]) continue;
    n++;
    nb.length = 0;                                            // sticks out from the neighbours' memories?
    const l = (i / B) | 0, c = i - l * B, tol = wallTol(g, i, cfg);
    for (let ll = Math.max(0, l - 1); ll <= Math.min(L - 1, l + 1); ll++)
      for (let cc = Math.max(0, c - 1); cc <= Math.min(B - 1, c + 1); cc++) { const v = wall[ll * B + cc]; if (v > 0) nb.push(v); }
    let v = w;
    if (nb.length >= 5) {
      nb.sort((x, y) => x - y);
      const med = nb[nb.length >> 1];
      if (Math.abs(w - med) > tol) v = med;
    }
    if (g.wallN[i] < cfg.walls.n) {                           // young: average with the neighbours' memories
      let k = 0, W = 0, sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, sxz = 0, syy = 0, syz = 0, szz = 0;
      for (let ll = Math.max(0, l - 1); ll <= Math.min(L - 1, l + 1); ll++)
        for (let cc = Math.max(0, c - 1); cc <= Math.min(B - 1, c + 1); cc++) {
          const j = ll * B + cc, u = wall[j], wt = g.wallN[j];
          if (u <= 0 || Math.abs(u - v) > 3 * tol) continue;
          const x = rayX[j] * u, y = rayY[j] * u, z = rayZ[j] * u;
          k++; W += wt; sx += wt * x; sy += wt * y; sz += wt * z;
          sxx += wt * x * x; sxy += wt * x * y; sxz += wt * x * z; syy += wt * y * y; syz += wt * y * z; szz += wt * z * z;
        }
      if (W > 0) {
        const cx = sx / W, cy = sy / W, cz = sz / W, ux = rayX[i], uy = rayY[i], uz = rayZ[i];
        const flat = k >= 4 && smallestEigenvector(sxx / W - cx * cx, sxy / W - cx * cy, sxz / W - cx * cz,
                                                   syy / W - cy * cy, syz / W - cy * cz, szz / W - cz * cz, nrm) > -0.5;   // −1 = degenerate (an exact plane can give −1e-17)
        const nr = nrm[0] * ux + nrm[1] * uy + nrm[2] * uz;
        const t = flat && Math.abs(nr) > 0.2 ? (nrm[0] * cx + nrm[1] * cy + nrm[2] * cz) / nr   // ray–plane intersection
                                             : cx * ux + cy * uy + cz * uz;                       // centroid on the ray
        if (Math.abs(t - v) <= 3 * tol) v = t;
      }
    }
    out[i] = v;
  }
  return n;
}
