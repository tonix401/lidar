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
  // the cross products of the rows of A − λI (no arrays: called once per beam by several stages)
  const a0 = xx - lam, a1 = yy - lam, a2 = zz - lam;
  const c0 = xy * yz - xz * a1, c1 = xz * xy - a0 * yz, c2 = a0 * a1 - xy * xy;            // r0 × r1
  const d0 = xy * a2 - xz * yz, d1 = xz * xz - a0 * a2, d2 = a0 * yz - xy * xz;            // r0 × r2
  const e0 = a1 * a2 - yz * yz, e1 = yz * xz - xy * a2, e2 = xy * yz - a1 * xz;            // r1 × r2
  const nc = c0 * c0 + c1 * c1 + c2 * c2, nd = d0 * d0 + d1 * d1 + d2 * d2, ne = e0 * e0 + e1 * e1 + e2 * e2;
  let bn = 0, b0 = 0, b1 = 0, b2 = 0;
  if (nc > bn) { bn = nc; b0 = c0; b1 = c1; b2 = c2; }
  if (nd > bn) { bn = nd; b0 = d0; b1 = d1; b2 = d2; }
  if (ne > bn) { bn = ne; b0 = e0; b1 = e1; b2 = e2; }
  if (bn < 1e-24) return -1;
  const s = 1 / Math.sqrt(bn);
  out[0] = b0 * s; out[1] = b1 * s; out[2] = b2 * s;
  return lam / Math.max(1e-12, xx + yy + zz);
}

/** median of a numeric array (copy-sorted); NaN for an empty array */
export function median(values: ArrayLike<number>): number {
  if (!values.length) return NaN;
  const s = Array.from(values).sort((a, b) => a - b);
  return s[s.length >> 1];
}
