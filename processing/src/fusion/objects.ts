// Objects seen by several sensors as one: each sensor keeps segmenting and tracking in its own range image
// (objects/detector.ts); here the beams of its tracked objects become world points, are moved to one common
// time by that object's velocity (the mirrors are not phase-locked, so scans are up to 50 ms apart: 7 cm at
// 1.5 m/s), and observations whose footprints touch are merged. One world tracker (the same Kalman tracker)
// then gives one track per real object instead of one per sensor, with a box and height from every sensor's
// points (docs/multisensor.md).
import type { Config } from "../config/config";
import type { ObjectDetector } from "../objects/detector";
import { MAX_MERGED_FOOTPRINT, type Detection } from "../objects/segment";
import { Tracker, type Track } from "../objects/tracker";
import type { Grid } from "../pipeline/grid";
import { VISIBLE_SIDE_OFFSET } from "./calib/walk";
import { invert, type Pose } from "./pose";

/** one sensor's tracked object in one scan, in world coordinates */
export interface Observation {
  sensor: number;              // index into the rig
  track: number;               // the sensor's own track id
  t: number;                   // scan time on the shared clock (s)
  points: Float32Array;        // world xyz of its beams
  vx: number; vy: number;      // world velocity from the sensor's track (m/s)
  from: number[];              // sensor position (world), for the visible-side correction
  clipped: boolean;
}

/** the tracked objects of one sensor's latest scan as observations. `ranges` must be what the detector
 *  segmented (g.raw): in the smoothed output, clean outlines draws an object's mixed pixels at the wall
 *  behind it, metres away, which would make its footprint too big to merge with anything. */
export function observe(sensor: number, pose: Pose, t: number, det: ObjectDetector, g: Grid, ranges: Float32Array = g.raw): Observation[] {
  const { R, t: o } = pose, byTrack = new Map<number, number[]>();
  for (let i = 0; i < det.cell.length; i++) {
    const id = det.cell[i], d = ranges[i];
    if (!id || !(d > 0)) continue;
    const x = g.rayX[i] * d, y = g.rayY[i] * d, z = g.rayZ[i] * d;
    let a = byTrack.get(id);
    if (!a) byTrack.set(id, (a = []));
    a.push(R[0] * x + R[1] * y + R[2] * z + o[0], R[3] * x + R[4] * y + R[5] * z + o[1], R[6] * x + R[7] * y + R[8] * z + o[2]);
  }
  const out: Observation[] = [];
  for (const [id, pts] of byTrack) {
    const tr = det.tracker.byId(id);
    if (!tr || !tr.det || tr.static) continue;
    out.push({ sensor, track: id, t, points: Float32Array.from(pts), vx: R[0] * tr.vx + R[1] * tr.vy, vy: R[3] * tr.vx + R[4] * tr.vy,
               from: [o[0], o[1], o[2]], clipped: tr.det.clipped });
  }
  return out;
}

/** a world track and what it is made of this scan */
export interface FusedObject { track: Track; sensors: number[]; points: Float32Array }

export class ObjectFusion {
  readonly tracker = new Tracker();
  /** confirmed world tracks with this tick's points */
  objects: FusedObject[] = [];
  /** (sensor, its track id) → world track id, for colouring each sensor's beams */
  readonly owner = new Map<string, number>();
  private lastT = 0;

  reset(): void { this.tracker.reset(); this.objects = []; this.owner.clear(); this.lastT = 0; }

  /** one tick: every sensor's latest observations, moved to time `t` */
  update(obs: Observation[], t: number, c: Config["objects"]): void {
    const dt = this.lastT && t > this.lastT && t - this.lastT < 1 ? t - this.lastT : 0.1;
    this.lastT = t;
    const groups = merge(obs.map(o => shift(o, t)));
    const dets = groups.map(g => detection(g));
    this.tracker.update(dets, dt, c);
    this.owner.clear();
    this.objects = [];
    for (const tr of this.tracker.tracks) {
      if (!tr.det) continue;
      const g = groups[dets.indexOf(tr.det)];
      for (const o of g) this.owner.set(`${o.sensor}:${o.track}`, tr.id);
      if (tr.confirmed) this.objects.push({ track: tr, sensors: [...new Set(g.map(o => o.sensor))], points: concat(g.map(o => o.points)) });
    }
  }

  get confirmed(): Track[] { return this.tracker.tracks.filter(t => t.confirmed); }

  /** world track id of sensor `sensor`'s track `id` (0 = none) */
  ownerOf(sensor: number, id: number): number { return this.owner.get(`${sensor}:${id}`) ?? 0; }
}

/** the observation moved by its velocity to time t */
function shift(o: Observation, t: number): Observation {
  const dt = t - o.t;
  if (!dt) return o;
  const p = Float32Array.from(o.points), dx = o.vx * dt, dy = o.vy * dt;
  for (let i = 0; i < p.length; i += 3) { p[i] += dx; p[i + 1] += dy; }
  return { ...o, points: p, t };
}

interface Footprint { x0: number; x1: number; y0: number; y1: number }
const footprint = (p: Float32Array): Footprint => {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
  return { x0, x1, y0, y1 };
};

export const MERGE_GAP = 0.3;

/** union-find: observations whose footprints are less than MERGE_GAP apart, never beyond MAX_MERGED_FOOTPRINT */
function merge(obs: Observation[]): Observation[][] {
  const fp = obs.map(o => footprint(o.points)), root = obs.map((_, i) => i), box = fp.map(f => ({ ...f }));
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  const pairs: [number, number, number][] = [];
  for (let i = 0; i < obs.length; i++) for (let j = i + 1; j < obs.length; j++) {
    const gap = Math.max(fp[i].x0 - fp[j].x1, fp[j].x0 - fp[i].x1, fp[i].y0 - fp[j].y1, fp[j].y0 - fp[i].y1, 0);
    if (gap < MERGE_GAP) pairs.push([gap, i, j]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  for (const [, i, j] of pairs) {
    const a = find(i), b = find(j);
    if (a === b) continue;
    const u = { x0: Math.min(box[a].x0, box[b].x0), x1: Math.max(box[a].x1, box[b].x1), y0: Math.min(box[a].y0, box[b].y0), y1: Math.max(box[a].y1, box[b].y1) };
    if (Math.max(u.x1 - u.x0, u.y1 - u.y0) > MAX_MERGED_FOOTPRINT) continue;
    root[b] = a; box[a] = u;
  }
  const groups = new Map<number, Observation[]>();
  obs.forEach((o, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), o]); });
  return [...groups.values()];
}

/** a Detection (as segment.ts makes them) from merged observations: the centre is the mean of each
 *  observation's centroid pushed back by VISIBLE_SIDE_OFFSET from its sensor, the box is the union's */
function detection(g: Observation[]): Detection {
  let cx = 0, cy = 0, w = 0, n = 0, z0 = Infinity, z1 = -Infinity, sz = 0;
  for (const o of g) {
    let mx = 0, my = 0;
    const k = o.points.length / 3;
    for (let i = 0; i < o.points.length; i += 3) { mx += o.points[i]; my += o.points[i + 1]; sz += o.points[i + 2]; z0 = Math.min(z0, o.points[i + 2]); z1 = Math.max(z1, o.points[i + 2]); }
    mx /= k; my /= k;
    const hx = mx - o.from[0], hy = my - o.from[1], h = Math.hypot(hx, hy) || 1;
    cx += k * (mx + VISIBLE_SIDE_OFFSET * hx / h); cy += k * (my + VISIBLE_SIDE_OFFSET * hy / h);
    w += k; n += k;
  }
  cx /= w; cy /= w;
  const pts = concat(g.map(o => o.points));
  let xx = 0, xy = 0, yy = 0, mx = 0, my = 0;
  for (let i = 0; i < pts.length; i += 3) { mx += pts[i]; my += pts[i + 1]; }
  mx /= n; my /= n;
  for (let i = 0; i < pts.length; i += 3) { const a = pts[i] - mx, b = pts[i + 1] - my; xx += a * a; xy += a * b; yy += b * b; }
  const yaw = 0.5 * Math.atan2(2 * xy, xx - yy), ux = Math.cos(yaw), uy = Math.sin(yaw);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const u = pts[i] * ux + pts[i + 1] * uy, v = -pts[i] * uy + pts[i + 1] * ux;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
  return { segments: [], n, x: cx, y: cy, z: sz / n, bx: uc * ux - vc * uy, by: uc * uy + vc * ux,
           len: Math.max(0.05, u1 - u0), wid: Math.max(0.05, v1 - v0), hgt: z1 - z0, yaw, z0, z1,
           l0: 0, l1: 0, b0: 0, b1: 0, clipped: g.every(o => o.clipped) };
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** a world track as seen from a sensor at `pose` (its yaw and position; tilt ignored): for the map, which
 *  draws one sensor's frame */
export function trackInFrame(t: Track, pose: Pose): Track {
  const { R, t: o } = invert(pose), c = R[0], s = R[3];
  const xy = (x: number, y: number): [number, number] => [c * x - s * y + o[0], s * x + c * y + o[1]];
  const [x, y] = xy(t.x, t.y), [dx, dy] = [c * t.box.dx - s * t.box.dy, s * t.box.dx + c * t.box.dy];
  const c2 = c * c - s * s, s2 = 2 * s * c, trail: number[] = [];
  for (let i = 0; i < t.trail.length; i += 2) trail.push(...xy(t.trail[i], t.trail[i + 1]));
  return { ...t, x, y, vx: c * t.vx - s * t.vy, vy: s * t.vx + c * t.vy, trail,
           box: { ...t.box, dx, dy, z0: t.box.z0 + o[2], z1: t.box.z1 + o[2], c2: c2 * t.box.c2 - s2 * t.box.s2, s2: s2 * t.box.c2 + c2 * t.box.s2 } };
}
