// Synthetic multi-sensor rig: a room (walls, floor, furniture, deliberately not symmetric) and people on
// paths over time, ray-cast with the MRS6224 geometry from any sensor pose. Stands in for the real sensors
// until they are here: calibration and fusion tests know the true poses and clock offsets.
import type { FrameMeta } from "../../src/core/types";
import { fromParams, rotate, type Pose } from "../../src/fusion/pose";
import { elevations, gauss, rng } from "./scene";

export interface Box3 { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }
export interface Person { x: number; y: number; r: number; h: number }
export interface Room {
  x0: number; x1: number; y0: number; y1: number; h: number;     // walls (inner faces) and their height; floor at z = 0
  boxes: Box3[];
  people: (t: number) => Person[];
}

export interface SimSensor {
  name: string;
  pose: Pose;                      // true pose in the world
  phase: number;                   // time of its first scan (s): the mirrors are not phase-locked
  L?: number; B?: number; az0?: number; step?: number;
  noise?: number;                  // σ of range noise (m)
  mixed?: number;                  // share of depth edges whose far beam returns a mixed echo (between the two)
  seed?: number;
}

/** a figure-of-eight-ish walk through the middle of the room, about 1 m/s; empty before `start` */
export function walker(start = 3, cx = 0, cy = 0): (t: number) => Person[] {
  return t => t < start ? [] : [{ x: cx + 2.0 * Math.sin(0.35 * (t - start)), y: cy + 1.3 * Math.sin(0.7 * (t - start) + 0.5), r: 0.2, h: 1.75 }];
}

export const ROOM: Room = {
  x0: -4, x1: 4.5, y0: -3, y1: 3.2, h: 2.6,
  boxes: [
    { x0: -4, x1: -3.2, y0: 1.8, y1: 3.2, z0: 0, z1: 1.9 },       // cabinet in a corner
    { x0: 1.6, x1: 2.6, y0: 2.2, y1: 3.2, z0: 0, z1: 0.75 },      // desk against the wall
    { x0: 3.6, x1: 3.9, y0: -0.8, y1: -0.5, z0: 0, z1: 2.6 },     // pillar
    { x0: -1.2, x1: -0.6, y0: -3, y1: -2.6, z0: 0, z1: 1.1 },     // box by the wall
  ],
  people: walker(),
};

/** three sensors around the room, about 1 m up, slightly tilted (as on real stands) */
export const RIG3: SimSensor[] = [
  { name: "a", pose: fromParams({ x: -3.4, y: -2.4, z: 1.05, yaw: 38, pitch: 2.5, roll: -1.2 }), phase: 0.013 },
  { name: "b", pose: fromParams({ x: 3.9, y: -2.3, z: 1.2, yaw: 142, pitch: -1.5, roll: 0.8 }), phase: 0.061 },
  { name: "c", pose: fromParams({ x: 0.4, y: 2.7, z: 0.95, yaw: -95, pitch: 1.0, roll: 1.6 }), phase: 0.087 },
];

export const simGeometry = (s: SimSensor) => {
  const B = s.B ?? 301;
  return { L: s.L ?? 24, B, az0: s.az0 ?? -60, step: s.step ?? 120 / (B - 1) };
};

/** distance along the ray (o, d) to the first surface, Infinity if none */
export function cast(room: Room, people: Person[], o: number[], d: number[]): number {
  let best = Infinity;
  const hit = (t: number, check: (p: number[]) => boolean) => {
    if (t > 1e-6 && t < best && check([o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]])) best = t;
  };
  if (d[2] < -1e-9) hit(-o[2] / d[2], p => p[0] >= room.x0 && p[0] <= room.x1 && p[1] >= room.y0 && p[1] <= room.y1);
  const inWall = (p: number[]) => p[2] >= 0 && p[2] <= room.h;
  if (d[0] > 1e-9) hit((room.x1 - o[0]) / d[0], inWall); else if (d[0] < -1e-9) hit((room.x0 - o[0]) / d[0], inWall);
  if (d[1] > 1e-9) hit((room.y1 - o[1]) / d[1], inWall); else if (d[1] < -1e-9) hit((room.y0 - o[1]) / d[1], inWall);
  for (const b of room.boxes) {                                       // slab method
    let t0 = -Infinity, t1 = Infinity;
    const lo = [b.x0, b.y0, b.z0], hi = [b.x1, b.y1, b.z1];
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-12) { if (o[k] < lo[k] || o[k] > hi[k]) { t0 = Infinity; break; } continue; }
      const a = (lo[k] - o[k]) / d[k], c = (hi[k] - o[k]) / d[k];
      t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
    }
    if (t0 <= t1 && t0 > 1e-6 && t0 < best) best = t0;
  }
  for (const p of people) {                                           // vertical cylinder, side only
    const a = d[0] * d[0] + d[1] * d[1]; if (a < 1e-12) continue;
    const fx = o[0] - p.x, fy = o[1] - p.y, b = fx * d[0] + fy * d[1], c = fx * fx + fy * fy - p.r * p.r;
    const disc = b * b - a * c; if (disc < 0) continue;
    hit((-b - Math.sqrt(disc)) / a, q => q[2] >= 0 && q[2] <= p.h);
  }
  return best;
}

/** one scan of sensor `s` at world time `t`: ranges, layer-major, 0 = no return */
export function castScan(s: SimSensor, room: Room, t: number, k = 0, maxRange = 60): Float32Array {
  const { L, B, az0, step } = simGeometry(s), el = elevations(L), people = room.people(t);
  const r = rng((s.seed ?? 1) * 100003 + k), out = new Float32Array(L * B);
  for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
    const az = (az0 + b * step) * Math.PI / 180, e = el[l] * Math.PI / 180;
    const dir = rotate(s.pose, [Math.cos(az) * Math.cos(e), Math.sin(az) * Math.cos(e), Math.sin(e)]);
    let d = cast(room, people, s.pose.t, dir);
    if (!isFinite(d) || d > maxRange) continue;
    if (s.noise) d += gauss(r) * s.noise;
    out[l * B + b] = Math.max(0, d);
  }
  // the real sensor merges the echoes of a beam that straddles an outline: a point between the two surfaces
  if (s.mixed) for (let l = 0; l < L; l++) for (let b = 0; b < B - 1; b++) {
    const i = l * B + b, p = out[i], q = out[i + 1];
    if (p > 0 && q > 0 && Math.abs(p - q) > 0.3 && r() < s.mixed) {
      const far = p > q ? i : i + 1;
      out[far] = (p + q) / 2 + (r() - 0.5) * Math.abs(p - q) * 0.6;
    }
  }
  return out;
}

/** full /api/frame payload: [distance | rssi | elevation] */
export function scanFrame(s: SimSensor, room: Room, t: number, k = 0): Float32Array {
  const { L, B } = simGeometry(s), N = L * B, el = elevations(L), f = new Float32Array(3 * N);
  f.set(castScan(s, room, t, k));
  f.fill(100, N, 2 * N);
  for (let l = 0; l < L; l++) f.fill(el[l], 2 * N + l * B, 2 * N + (l + 1) * B);
  return f;
}

export function simMeta(s: SimSensor, ts: number, id = 1): FrameMeta {
  const { L, B, az0, step } = simGeometry(s);
  return { id, points: 0, layers: L, beams: B, start_azimuth_deg: az0, step_deg: step, rate: 10, scan_frequency_hz: 10, ts };
}

/** the time of sensor `s`'s scan k (s) */
export const scanTime = (s: SimSensor, k: number) => s.phase + 0.1 * k;

/** a world point as sensor `s` sees it (for tests that compare positions) */
export const toSensor = (s: SimSensor, p: number[]) => {
  const R = s.pose.R, q = [p[0] - s.pose.t[0], p[1] - s.pose.t[1], p[2] - s.pose.t[2]];
  return [R[0] * q[0] + R[3] * q[1] + R[6] * q[2], R[1] * q[0] + R[4] * q[1] + R[7] * q[2], R[2] * q[0] + R[5] * q[1] + R[8] * q[2]];
};
