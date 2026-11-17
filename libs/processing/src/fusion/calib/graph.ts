// Putting pairwise measurements together into one rig (Quenzel et al. 2016, "Robust extrinsic calibration of
// multiple stationary laser range finders"): every pair of sensors that saw the walker together gives an edge
// (where one stands in the other's frame), and all poses are solved at once by least squares, with the main
// sensor fixed. Placing the sensors one by one instead, each against one already placed, adds up the errors along
// the chain and ignores every other pair that saw the same walk. Edges that disagree with the rest after the solve
// are dropped (when the rig stays connected without them) and the rig is solved again. The plane (x, y, yaw) is
// solved apart from the heights and the clocks, which are each one number per sensor, so a linear problem.
import { solve } from "../linalg";

/** where sensor j stands in sensor i's frame (rad, m), and how much to trust it */
export interface PlanarEdge { i: number; j: number; theta: number; tx: number; ty: number; w: number }
export type Planar = [theta: number, x: number, y: number];

export interface PlanarResult {
  poses: (Planar | null)[];      // null: not connected to the fixed sensor by any edge
  used: boolean[];               // per edge: kept (false: dropped as disagreeing)
  error: number[];               // per edge, after the solve: how far it disagrees (m, rotation counted at `lever`)
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** sensor j in sensor i's frame, from both in the world */
function relative(a: Planar, b: Planar): Planar {
  const c = Math.cos(a[0]), s = Math.sin(a[0]), dx = b[1] - a[1], dy = b[2] - a[2];
  return [wrap(b[0] - a[0]), c * dx + s * dy, -s * dx + c * dy];
}

function compose(a: Planar, b: Planar): Planar {
  const c = Math.cos(a[0]), s = Math.sin(a[0]);
  return [wrap(a[0] + b[0]), a[1] + c * b[1] - s * b[2], a[2] + s * b[1] + c * b[2]];
}

/** which sensors the edges connect to `fixed` */
function reach(n: number, fixed: number, edges: { i: number; j: number }[]): boolean[] {
  const seen = new Array<boolean>(n).fill(false), todo = [fixed];
  seen[fixed] = true;
  while (todo.length) {
    const k = todo.pop()!;
    for (const e of edges) for (const [a, b] of [[e.i, e.j], [e.j, e.i]]) if (a === k && !seen[b]) { seen[b] = true; todo.push(b); }
  }
  return seen;
}

export interface PlanarOptions { lever?: number; huber?: number; maxIter?: number; outlier?: number }

export function solvePlanar(n: number, fixed: number, edges: PlanarEdge[], o: PlanarOptions = {}): PlanarResult {
  const L = o.lever ?? 3, k = o.huber ?? 0.1, maxIter = o.maxIter ?? 20, outlier = o.outlier ?? 3;
  let used = edges.map(() => true);
  const live = () => edges.filter((_, e) => used[e]);
  const errorOf = (poses: (Planar | null)[], e: PlanarEdge) => {
    const r = relative(poses[e.i]!, poses[e.j]!);
    return Math.hypot(L * wrap(r[0] - e.theta), r[1] - e.tx, r[2] - e.ty);
  };

  const run = (): (Planar | null)[] => {
    const es = live(), connected = reach(n, fixed, es);
    // start: the heaviest spanning tree from the fixed sensor (Prim)
    const poses: (Planar | null)[] = new Array(n).fill(null);
    poses[fixed] = [0, 0, 0];
    for (;;) {
      let best: PlanarEdge | null = null, fromI = true;
      for (const e of es) {
        const a = poses[e.i] !== null, b = poses[e.j] !== null;
        if (a !== b && (!best || e.w > best.w)) { best = e; fromI = a; }
      }
      if (!best) break;
      if (fromI) poses[best.j] = compose(poses[best.i]!, [best.theta, best.tx, best.ty]);
      else {                                                  // i from j: the inverse of the edge
        const c = Math.cos(best.theta), s = Math.sin(best.theta);
        poses[best.i] = compose(poses[best.j]!, [-best.theta, -(c * best.tx + s * best.ty), s * best.tx - c * best.ty]);
      }
    }
    // Gauss–Newton with Huber weights over the free, connected sensors (numerical Jacobian: a few dozen numbers)
    const free = poses.flatMap((p, s) => (p && s !== fixed && connected[s] ? [s] : [])), M = 3 * free.length;
    if (!M) return poses;
    const slot = new Map(free.map((s, m) => [s, m]));
    const residuals = (P: (Planar | null)[]) => es.flatMap(e => {
      const r = relative(P[e.i]!, P[e.j]!), q = [L * wrap(r[0] - e.theta), r[1] - e.tx, r[2] - e.ty], norm = Math.hypot(...q);
      const w = Math.sqrt(e.w * (norm <= k ? 1 : k / norm));
      return q.map(v => w * v);
    });
    for (let it = 0; it < maxIter; it++) {
      const r0 = residuals(poses), J: number[][] = [];
      for (const s of free) for (let c = 0; c < 3; c++) {
        const P = poses.slice(), p = [...P[s]!] as Planar;
        p[c] += 1e-6; P[s] = p;
        J.push(residuals(P).map((v, x) => (v - r0[x]) / 1e-6));
      }
      const H = new Array<number>(M * M).fill(0), g = new Array<number>(M).fill(0);
      for (let a = 0; a < M; a++) for (let x = 0; x < r0.length; x++) {
        g[a] -= J[a][x] * r0[x];
        for (let b = 0; b < M; b++) H[a * M + b] += J[a][x] * J[b][x];
      }
      for (let a = 0; a < M; a++) H[a * M + a] += 1e-9;
      const step = solve(H, g, M);
      if (!step) break;
      for (const s of free) { const m = 3 * slot.get(s)!, p = poses[s]!; poses[s] = [wrap(p[0] + step[m]), p[1] + step[m + 1], p[2] + step[m + 2]]; }
      if (Math.max(...step.map(Math.abs)) < 1e-7) break;
    }
    return poses;
  };

  let poses = run();
  for (let round = 0; round < 3; round++) {                 // drop the worst disagreeing edge while the rig stays together
    const err = edges.map((e, x) => (used[x] && poses[e.i] && poses[e.j] ? errorOf(poses, e) : 0));
    const live = err.filter((_, e) => used[e]).sort((a, b) => a - b), med = live[live.length >> 1] ?? 0;
    const order = err.map((v, e) => [v, e]).filter(([v, e]) => used[e] && v > Math.max(outlier * med, 0.1)).sort((a, b) => b[0] - a[0]);
    const before = reach(n, fixed, edges.filter((_, e) => used[e]));
    const drop = order.find(([, e]) => {
      const trial = used.map((u, x) => u && x !== e), after = reach(n, fixed, edges.filter((_, x) => trial[x]));
      return before.every((b, s) => !b || after[s]);
    });
    if (!drop) break;
    used = used.map((u, x) => u && x !== drop[1]);
    poses = run();
  }
  return { poses, used, error: edges.map(e => (poses[e.i] && poses[e.j] ? errorOf(poses, e) : NaN)) };
}

/** a value per sensor from differences between pairs (x_j − x_i = d) and direct readings of some (x_i = v), by
 *  weighted least squares. null for sensors that no reading reaches. */
export function solveLinear(n: number, readings: { i: number; v: number; w: number }[], diffs: { i: number; j: number; d: number; w: number }[]): (number | null)[] {
  const known = new Array<boolean>(n).fill(false), todo = readings.map(r => r.i);
  for (const i of todo) known[i] = true;
  while (todo.length) {
    const k = todo.pop()!;
    for (const e of diffs) for (const [a, b] of [[e.i, e.j], [e.j, e.i]]) if (a === k && !known[b]) { known[b] = true; todo.push(b); }
  }
  const H = new Array<number>(n * n).fill(0), g = new Array<number>(n).fill(0);
  for (const r of readings) { H[r.i * n + r.i] += r.w; g[r.i] += r.w * r.v; }
  for (const e of diffs) {
    H[e.i * n + e.i] += e.w; H[e.j * n + e.j] += e.w; H[e.i * n + e.j] -= e.w; H[e.j * n + e.i] -= e.w;
    g[e.j] += e.w * e.d; g[e.i] -= e.w * e.d;
  }
  for (let i = 0; i < n; i++) if (!known[i]) H[i * n + i] += 1;      // unreached: pinned to 0, reported as null
  const x = solve(H, g, n);
  return known.map((k, i) => (k && x ? x[i] : null));
}
