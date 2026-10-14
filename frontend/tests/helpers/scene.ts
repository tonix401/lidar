// Synthetic scans by ray casting a simple room: wall at x = wallX, floor at z = floorZ, optional
// vertical cylinders (people/objects). Geometry like the MRS6224: 24 layers from −13.2° to +1.2°.
import type { FrameMeta } from "../../src/core/types";

export interface Cylinder { x: number; y: number; r: number; z0: number; z1: number }
export interface SceneOptions {
  L?: number; B?: number; az0?: number; step?: number;
  wallX?: number; floorZ?: number; maxRange?: number;
  objects?: Cylinder[];
  noise?: number;                  // σ of range noise (m)
  seed?: number;
  layerOffsets?: number[];         // per-layer constant range offset (m), like the real sensor's waves
  quantize?: boolean;              // 12.5 mm steps
}

export function rng(seed: number): () => number {        // mulberry32
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
}

export const elevations = (L: number): number[] => Array.from({ length: L }, (_, l) => -13.2 + l * (14.4 / (L - 1)));

export function meta(o: SceneOptions = {}, extra: Partial<FrameMeta> = {}): FrameMeta {
  const L = o.L ?? 24, B = o.B ?? 181;
  return { id: 1, points: 0, layers: L, beams: B, start_azimuth_deg: o.az0 ?? -60, step_deg: o.step ?? 120 / (B - 1),
           rate: 10, scan_frequency_hz: 10, ts: 1000, ...extra };
}

/** ranges only (layer-major), 0 = no return */
export function castRanges(o: SceneOptions = {}): Float32Array {
  const L = o.L ?? 24, B = o.B ?? 181, az0 = o.az0 ?? -60, step = o.step ?? 120 / (B - 1);
  const wallX = o.wallX ?? 5, floorZ = o.floorZ ?? -1, maxR = o.maxRange ?? 60;
  const r = rng(o.seed ?? 1), el = elevations(L), out = new Float32Array(L * B);
  for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
    const az = (az0 + b * step) * Math.PI / 180, e = el[l] * Math.PI / 180;
    const rx = Math.cos(az) * Math.cos(e), ry = Math.sin(az) * Math.cos(e), rz = Math.sin(e);
    let d = Infinity;
    if (rx > 1e-6) d = Math.min(d, wallX / rx);
    if (rz < -1e-6) d = Math.min(d, floorZ / rz);
    for (const c of o.objects ?? []) {                     // ray vs vertical cylinder (2D), then height check
      const h = Math.hypot(rx, ry); if (h < 1e-9) continue;
      const ux = rx / h, uy = ry / h, along = c.x * ux + c.y * uy, perp2 = c.x * c.x + c.y * c.y - along * along;
      if (perp2 > c.r * c.r) continue;
      const t2 = along - Math.sqrt(c.r * c.r - perp2);
      if (t2 <= 0) continue;
      const t = t2 / h, z = rz * t;
      if (z >= c.z0 && z <= c.z1) d = Math.min(d, t);
    }
    if (!isFinite(d) || d > maxR) continue;
    d += (o.layerOffsets?.[l] ?? 0) + (o.noise ? gauss(r) * o.noise : 0);
    if (o.quantize) d = Math.round(d / 0.0125) * 0.0125;
    out[l * B + b] = Math.max(0, d);
  }
  return out;
}

/** full /api/frame payload: [distance | rssi | elevation] */
export function frameData(o: SceneOptions = {}): Float32Array {
  const L = o.L ?? 24, B = o.B ?? 181, N = L * B, el = elevations(L);
  const f = new Float32Array(3 * N);
  f.set(castRanges(o));
  f.fill(100, N, 2 * N);
  for (let l = 0; l < L; l++) f.fill(el[l], 2 * N + l * B, 2 * N + (l + 1) * B);
  return f;
}
