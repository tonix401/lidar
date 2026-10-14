export const DEG = Math.PI / 180;

/** distance tolerance used everywhere for "same surface": absolute part covers the 12.5 mm range
 *  quantisation (and noise), relative part grows with range */
export const sameTol = (d: number, abs: number, rel: number): number => abs + rel * d;

export function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Smallest eigenvector of a symmetric 3x3 covariance (trigonometric eigenvalues, then the largest
 *  cross product of two rows of A − λI). Writes the unit normal into `out` and returns the surface
 *  variation λmin / trace ("curvature"), or −1 when degenerate. */
export function smallestEigenvector(xx: number, xy: number, xz: number, yy: number, yz: number, zz: number,
                                    out: number[]): number {
  const p1 = xy * xy + xz * xz + yz * yz, q = (xx + yy + zz) / 3;
  const p2 = (xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  if (p < 1e-12) return -1;
  const b11 = (xx - q) / p, b22 = (yy - q) / p, b33 = (zz - q) / p, b12 = xy / p, b13 = xz / p, b23 = yz / p;
  const r = Math.max(-1, Math.min(1, (b11 * (b22 * b33 - b23 * b23) - b12 * (b12 * b33 - b23 * b13) + b13 * (b12 * b23 - b22 * b13)) / 2));
  const phi = Math.acos(r) / 3;
  const lam = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);          // smallest eigenvalue
  const r0 = [xx - lam, xy, xz], r1 = [xy, yy - lam, yz], r2 = [xz, yz, zz - lam];
  const cr = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  let best: number[] | null = null, bn = 0;
  for (const c of [cr(r0, r1), cr(r0, r2), cr(r1, r2)]) {
    const n = c[0] * c[0] + c[1] * c[1] + c[2] * c[2];
    if (n > bn) { bn = n; best = c; }
  }
  if (!best || bn < 1e-24) return -1;
  const s = 1 / Math.sqrt(bn);
  out[0] = best[0] * s; out[1] = best[1] * s; out[2] = best[2] * s;
  return lam / Math.max(1e-12, xx + yy + zz);
}

/** median of a numeric array (copy-sorted); NaN for an empty array */
export function median(values: ArrayLike<number>): number {
  if (!values.length) return NaN;
  const s = Array.from(values).sort((a, b) => a - b);
  return s[s.length >> 1];
}
