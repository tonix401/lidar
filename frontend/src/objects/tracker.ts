// Tracking (SORT / AB3DMOT style): Kalman predict, greedy nearest-neighbour association inside a gate,
// confirmation after CONFIRM_HITS hits, coasting for `coast` scans; rule-based classification.
import type { Config } from "../config/config";
import { trackColor } from "../core/colors";
import type { RGB } from "../core/types";
import { kfInit, kfPredict, kfUpdate, type KalmanState } from "./kalman";
import type { Detection } from "./segment";

export const MAX_TRACKS = 64, TRAIL_MAX = 60, CONFIRM_HITS = 3, MOVED_M = 0.5;

export type TrackClass = "person" | "moving object" | "object" | "static object";

export interface Box { dx: number; dy: number; len: number; wid: number; z0: number; z1: number; c2: number; s2: number }

export interface Track extends KalmanState {
  id: number;
  x0: number; y0: number; maxDisp: number;
  hits: number; misses: number; confirmed: boolean;
  moved: boolean; static: boolean; age: number; speed: number;
  personScore: number; cls: TrackClass;
  det: Detection | null;          // matched detection this scan
  trail: number[];                // x, y pairs
  box: Box;                       // smoothed box, relative to the filtered position
  color: RGB;
}

/** person: upright body-sized box that moved at some point (or is clearly tall). The vertical field of
 *  view is only ~15°, so `hgt` is the visible height and only a lower bound for clipped objects. The
 *  footprint may be as long as an arm span (about body height: arms stretched out). */
export const PERSON_LEN = 1.7, PERSON_WID = 0.9;
export function isPersonLike(d: Detection, moved: boolean): boolean {
  return d.hgt >= 0.35 && d.len <= PERSON_LEN && d.wid <= PERSON_WID && (moved || d.hgt >= 1.0);
}

/** person score (EMA of isPersonLike) with hysteresis, so the label doesn't flip with every gesture */
export const PERSON_ON = 0.6, PERSON_OFF = 0.3;

export class Tracker {
  tracks: Track[] = [];
  private nextId = 1;
  private index = new Map<number, Track>();

  reset(): void { this.tracks = []; this.index.clear(); }

  byId(id: number): Track | undefined { return this.index.get(id); }

  update(detections: Detection[], dt: number, c: Config["objects"]): void {
    const ema = (a: number, b: number, w: number) => a + w * (b - a);
    for (const t of this.tracks) kfPredict(t, dt);
    const pairs: [number, Track, Detection][] = [];
    for (const t of this.tracks) for (const d of detections) {
      const dist = Math.hypot(d.x - t.x, d.y - t.y);
      if (dist <= c.gate) pairs.push([dist, t, d]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const usedT = new Set<Track>(), usedD = new Set<Detection>();
    for (const [, t, d] of pairs) {
      if (usedT.has(t) || usedD.has(d)) continue;
      usedT.add(t); usedD.add(d);
      kfUpdate(t, d.x, d.y);
      t.hits++; t.misses = 0; t.det = d;
      if (t.hits >= CONFIRM_HITS) t.confirmed = true;
      const b = t.box;                                // yaw averaged on the doubled angle (±90° is the same box)
      b.dx = ema(b.dx, d.bx - d.x, 0.3); b.dy = ema(b.dy, d.by - d.y, 0.3);
      b.len = ema(b.len, d.len, 0.3); b.wid = ema(b.wid, d.wid, 0.3); b.z0 = ema(b.z0, d.z0, 0.3); b.z1 = ema(b.z1, d.z1, 0.3);
      b.c2 = ema(b.c2, Math.cos(2 * d.yaw), 0.3); b.s2 = ema(b.s2, Math.sin(2 * d.yaw), 0.3);
      t.maxDisp = Math.max(t.maxDisp, Math.hypot(t.x - t.x0, t.y - t.y0));
      if (t.maxDisp > MOVED_M) t.moved = true;
      this.classify(t, d);
    }
    for (const t of this.tracks) if (!usedT.has(t)) { t.misses++; t.det = null; }
    this.tracks = this.tracks.filter(t => t.confirmed ? t.misses <= c.coast : t.misses === 0);
    for (const d of detections) {
      if (usedD.has(d) || this.tracks.length >= MAX_TRACKS) continue;
      const id = this.nextId++;
      const t: Track = { id, ...kfInit(d.x, d.y), x0: d.x, y0: d.y, maxDisp: 0, hits: 1, misses: 0, confirmed: false,
        moved: false, static: false, age: 0, speed: 0, personScore: 0, cls: "object", det: d, trail: [], color: trackColor(id),
        box: { dx: d.bx - d.x, dy: d.by - d.y, len: d.len, wid: d.wid, z0: d.z0, z1: d.z1, c2: Math.cos(2 * d.yaw), s2: Math.sin(2 * d.yaw) } };
      this.classify(t, d);
      this.tracks.push(t);
    }
    for (const t of this.tracks) {
      t.age += dt;
      t.speed = Math.hypot(t.vx, t.vy);
      t.static = !t.moved && t.age > c.learn;          // never moved: new scenery, let the background absorb it
      if (t.static) t.cls = "static object";
      if (t.confirmed) { t.trail.push(t.x, t.y); if (t.trail.length > 2 * TRAIL_MAX) t.trail.splice(0, 2); }
    }
    this.index = new Map(this.tracks.map(t => [t.id, t]));
  }

  private classify(t: Track, d: Detection): void {
    t.personScore += 0.25 * ((isPersonLike(d, t.moved) ? 1 : 0) - t.personScore);
    const person = t.cls === "person" ? t.personScore >= PERSON_OFF : t.personScore > PERSON_ON;
    t.cls = person ? "person" : t.moved ? "moving object" : "object";
  }
}

/** 8 box corners [x, y, z] at the track's filtered position (bottom 4, then top 4) */
export function boxCorners(t: Track, pad = 0.05): [number, number, number][] {
  const b = t.box, yaw = 0.5 * Math.atan2(b.s2, b.c2), ux = Math.cos(yaw), uy = Math.sin(yaw);
  const cx = t.x + b.dx, cy = t.y + b.dy, hl = b.len / 2 + pad, hw = b.wid / 2 + pad, out: [number, number, number][] = [];
  for (const z of [b.z0 - pad, b.z1 + pad]) for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
    out.push([cx + su * hl * ux - sv * hw * uy, cy + su * hl * uy + sv * hw * ux, z]);
  return out;
}

export const trackLabel = (t: Track): string =>
  `#${t.id} ${t.cls}` + (t.speed > 0.15 ? ` · ${t.speed.toFixed(1)} m/s` : "") + ` · ${Math.hypot(t.x, t.y).toFixed(1)} m`;
