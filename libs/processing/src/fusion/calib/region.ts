// A region of the world, from above, outside of which calibration ignores everything: a polygon of x, y pairs (m),
// for leaving out neighbouring rooms, windows and passers-by. The world frame is the one of a solved calibration.
import { apply, type Pose } from "../pose";

export type Region = [number, number][];

export const MIN_VERTICES = 3, MAX_VERTICES = 200;

/** even-odd rule; a point exactly on an edge may count either way */
export function pointInPolygon(x: number, y: number, poly: Region): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** no two edges that are not neighbours cross */
export function polygonSimple(poly: Region): boolean {
  const n = poly.length, cross = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (j === i + 1 || (i === 0 && j === n - 1)) continue;
    const a = poly[i], b = poly[(i + 1) % n], c = poly[j], d = poly[(j + 1) % n];
    if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return false;
  }
  return true;
}

/** `poly` as a Region, or throws what is wrong with it */
export function checkRegion(poly: unknown): Region {
  if (!Array.isArray(poly) || poly.length < MIN_VERTICES || poly.length > MAX_VERTICES)
    throw new Error(`a region needs ${MIN_VERTICES} to ${MAX_VERTICES} corners`);
  const out = poly.map(p => {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e4))
      throw new Error("a corner is [x, y] in metres");
    return [p[0], p[1]] as [number, number];
  });
  if (!polygonSimple(out)) throw new Error("the region's edges cross each other");
  return out;
}

export interface CropInput {
  data: { L: number; B: number; rayX: Float32Array; rayY: Float32Array; rayZ: Float32Array; bg: Float32Array };
  walk: { t: number; x: number; y: number; z: number; z0?: number }[];
  pose: Pose;                                       // sensor → world
}

/** copies of each sensor's empty scene and walk without what lies outside `region` (beams are set to no return) */
export function cropToRegion(inputs: CropInput[], region: Region): { data: CropInput["data"]; walk: CropInput["walk"]; cut: number }[] {
  return inputs.map(({ data, walk, pose }) => {
    const bg = Float32Array.from(data.bg), { rayX, rayY, rayZ } = data;
    let cut = 0;
    for (let i = 0; i < bg.length; i++) {
      const r = bg[i];
      if (!(r > 0)) continue;
      const w = apply(pose, [rayX[i] * r, rayY[i] * r, rayZ[i] * r]);
      if (!pointInPolygon(w[0], w[1], region)) { bg[i] = 0; cut++; }
    }
    const kept = walk.filter(s => { const w = apply(pose, [s.x, s.y, s.z]); return pointInPolygon(w[0], w[1], region); });
    return { data: { ...data, bg }, walk: kept, cut: cut + walk.length - kept.length };
  });
}
