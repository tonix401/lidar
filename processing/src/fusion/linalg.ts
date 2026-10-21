// Small dense linear algebra for calibration (6×6 normal equations, their eigenvectors).

/** solve A x = b (A n×n row-major; neither is changed) by Gaussian elimination with partial pivoting;
 *  null if A is singular */
export function solve(A: ArrayLike<number>, b: ArrayLike<number>, n: number): number[] | null {
  const M = Array.from({ length: n }, (_, i) => [...Array.from({ length: n }, (_, j) => A[i * n + j]), b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** eigenvalues (ascending) and unit eigenvectors of a symmetric n×n matrix, by cyclic Jacobi rotations */
export function symEigen(A: ArrayLike<number>, n: number): { values: number[]; vectors: number[][] } {
  const a = Array.from(A), v: number[] = Array.from({ length: n * n }, (_, i) => (i % (n + 1) === 0 ? 1 : 0));
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = a[p * n + q];
      if (Math.abs(apq) < 1e-300) continue;
      const th = (a[q * n + q] - a[p * n + p]) / (2 * apq);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {                    // A ← Jᵀ A J, columns then rows
        const akp = a[k * n + p], akq = a[k * n + q];
        a[k * n + p] = c * akp - s * akq; a[k * n + q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = a[p * n + k], aqk = a[q * n + k];
        a[p * n + k] = c * apk - s * aqk; a[q * n + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = v[k * n + p], vkq = v[k * n + q];
        v[k * n + p] = c * vkp - s * vkq; v[k * n + q] = s * vkp + c * vkq;
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i * n + i] - a[j * n + j]);
  return { values: order.map(i => a[i * n + i]), vectors: order.map(i => Array.from({ length: n }, (_, k) => v[k * n + i])) };
}

/** rigid 2D transform (rotation θ, translation) that best maps points `from` onto `to` (least squares,
 *  Kabsch/Umeyama in 2D: the angle has a closed form) */
export function kabsch2d(from: ArrayLike<number>[], to: ArrayLike<number>[]): { theta: number; tx: number; ty: number } {
  const n = from.length;
  let fx = 0, fy = 0, gx = 0, gy = 0;
  for (let i = 0; i < n; i++) { fx += from[i][0]; fy += from[i][1]; gx += to[i][0]; gy += to[i][1]; }
  fx /= n; fy /= n; gx /= n; gy /= n;
  let sc = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    const ax = from[i][0] - fx, ay = from[i][1] - fy, bx = to[i][0] - gx, by = to[i][1] - gy;
    sc += ax * bx + ay * by; ss += ax * by - ay * bx;
  }
  const theta = Math.atan2(ss, sc), c = Math.cos(theta), s = Math.sin(theta);
  return { theta, tx: gx - (c * fx - s * fy), ty: gy - (s * fx + c * fy) };
}
