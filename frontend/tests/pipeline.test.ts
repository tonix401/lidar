import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/config";
import { bilateral } from "../src/pipeline/bilateral";
import { Cells } from "../src/pipeline/cells";
import { dynSmooth } from "../src/pipeline/dynsmooth";
import { createGrid, resetHistory } from "../src/pipeline/grid";
import { historyFilter } from "../src/pipeline/history";
import { intensityFilter, rssiHistogram } from "../src/pipeline/intensity";
import { applyLayerBias, removeUnobservable, updateLayerBias } from "../src/pipeline/layercal";
import { FlickerMeter, movingRoughness } from "../src/pipeline/metrics";
import { detectMotion } from "../src/pipeline/motion";
import { rejectOutliers } from "../src/pipeline/outlier";
import { flattenPlanes } from "../src/pipeline/planes";
import { Processor } from "../src/pipeline/processor";
import { updateRays } from "../src/pipeline/rays";
import { temporalUpdate } from "../src/pipeline/temporal";
import { dropMixed, frontMask, snapToWall } from "../src/pipeline/outline";
import { DROPPED, FRONT, updateWall, WALL_CONFIRM, WALL_N, wallFill } from "../src/pipeline/wall";
import { castRanges, elevations, frameData, meta, type Cylinder } from "./helpers/scene";

function gridFor(o = {}) {
  const m = meta(o), g = createGrid(m.layers, m.beams);
  g.elev.set(frameData(o).subarray(2 * g.N));
  updateRays(g, m.start_azimuth_deg, m.step_deg, "upright");
  return g;
}

const rms = (a: Float32Array, b: Float32Array) => {
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > 0 && b[i] > 0) { s += (a[i] - b[i]) ** 2; n++; }
  return Math.sqrt(s / n);
};

describe("rays", () => {
  it("upright vs upside down flips only z", () => {
    const g = gridFor();
    const x = g.rayX[5], y = g.rayY[5], z = g.rayZ[5];
    expect(z).toBeLessThan(0);                                   // bottom layer looks down
    updateRays(g, -60, 120 / 180, "upsidedown");
    expect([g.rayX[5], g.rayY[5], g.rayZ[5]]).toEqual([x, y, -z]);
    expect(Math.hypot(g.rayX[100], g.rayY[100], g.rayZ[100])).toBeCloseTo(1);
  });
});

describe("intensity", () => {
  it("histogram and window filter", () => {
    const d = Float32Array.from([1, 1, 0, 1]), r = Float32Array.from([5, 100, 50, 500]);
    expect(rssiHistogram(d, r)[0]).toBe(1);
    const out = new Float32Array(4);
    expect(intensityFilter(d, r, out, { on: true, min: 10, max: 400 })).toBe(2);
    expect(Array.from(out)).toEqual([0, 1, 0, 0]);
    expect(intensityFilter(d, r, out, { on: false, min: 10, max: 400 })).toBe(0);
  });
});

describe("outliers", () => {
  it("removes isolated spikes, keeps surfaces", () => {
    const g = gridFor(), cfg = defaultConfig();
    const src = castRanges(), dst = new Float32Array(g.N);
    const spike = 10 * g.B + 90;
    src[spike] = 1.0;                                            // lone return 1 m in front of the wall
    const removed = rejectOutliers(g, src, dst, cfg);
    expect(dst[spike]).toBe(0);
    expect(removed).toBeLessThan(5);
    expect(dst[10 * g.B + 50]).toBe(src[10 * g.B + 50]);
  });
});

describe("temporal", () => {
  it("averages noise on a static scene and follows a real change after confirmation", () => {
    const g = gridFor(), cfg = defaultConfig(), truth = castRanges();
    for (let k = 0; k < 20; k++) { g.frames = Math.min(32, g.frames + 1); temporalUpdate(g, castRanges({ noise: 0.02, seed: k + 1 }), cfg); }
    expect(rms(g.temporal, truth)).toBeLessThan(0.012);          // ~σ/√10
    const i = 12 * g.B + 90, moved = castRanges();
    moved[i] = truth[i] - 1;                                     // something 1 m in front
    temporalUpdate(g, moved, cfg);
    expect(g.temporal[i]).toBeCloseTo(truth[i], 1);              // one sample: ignored
    temporalUpdate(g, moved, cfg);
    expect(g.temporal[i]).toBeCloseTo(truth[i] - 1, 2);          // confirmed: follows
    expect(g.alt[i]).toBeGreaterThan(truth[i] - 0.1);            // old surface kept as 2nd mode
    resetHistory(g);
    expect(g.frames).toBe(0);
    expect(g.temporal.every(v => v === 0)).toBe(true);
  });
});

describe("motion", () => {
  it("flags a person-sized cluster that appears in front of the background", () => {
    const g = gridFor(), cfg = defaultConfig();
    for (let k = 0; k < 8; k++) { g.frames++; const s = castRanges({ noise: 0.01, seed: k + 1 }); detectMotion(g, s, cfg); temporalUpdate(g, s, cfg); }
    g.frames++;
    const withPerson = castRanges({ noise: 0.01, seed: 99, objects: [{ x: 3, y: 0, r: 0.25, z0: -1, z1: 0.8 }] });
    expect(detectMotion(g, withPerson, cfg)).toBe(1);
    const moving = Array.from(g.motionHold).filter(v => v > 0).length;
    expect(moving).toBeGreaterThan(20);
    expect(moving).toBeLessThan(400);
  });
});

describe("history + bilateral + planes", () => {
  it("drops flickering beams", () => {
    const g = gridFor(), cfg = defaultConfig(), src = castRanges(), dst = new Float32Array(g.N);
    g.frames = 32; g.validBits.fill(0xffffffff);
    g.validBits[100] = 0x11111111;                             // valid 25 % of the time
    expect(historyFilter(g, src, dst, cfg)).toBe(1);
    expect(dst[100]).toBe(0);
  });

  it("bilateral smooths a noisy wall but keeps a depth edge", () => {
    const g = gridFor(), cfg = defaultConfig(), truth = castRanges({ objects: [{ x: 2, y: 0, r: 0.3, z0: -1, z1: 2 }] });
    const noisy = castRanges({ noise: 0.02, seed: 3, objects: [{ x: 2, y: 0, r: 0.3, z0: -1, z1: 2 }] });
    g.conf.fill(1);
    const out = new Float32Array(g.N);
    bilateral(g, noisy, out, cfg);
    expect(rms(out, truth)).toBeLessThan(rms(noisy, truth) * 0.8);
    let maxEdgeErr = 0;                                         // beams next to the cylinder silhouette
    for (let i = 0; i < g.N; i++) if (Math.abs(out[i] - truth[i]) > maxEdgeErr && truth[i] > 0) maxEdgeErr = Math.abs(out[i] - truth[i]);
    expect(maxEdgeErr).toBeLessThan(0.5);                       // never blends the 3 m jump
  });

  it("planes flatten a noisy wall and mark it flat", () => {
    // wall only: where wall and floor meet at grazing angles both are within the same-surface
    // tolerance and get fitted as one plane (a known limitation of local plane fits)
    const o = { floorZ: -50 }, g = gridFor(o), cfg = defaultConfig(), truth = castRanges(o), noisy = castRanges({ ...o, noise: 0.015, seed: 5 });
    g.conf.fill(1);
    const out = new Float32Array(g.N);
    flattenPlanes(g, noisy, out, cfg);
    expect(rms(out, truth)).toBeLessThan(rms(noisy, truth) * 0.35);
    expect(Array.from(g.area).filter(a => a === 0).length).toBeGreaterThan(g.N * 0.5);
  });
});

describe("moving areas", () => {
  // a person-sized cylinder in front of the wall, all its beams flagged moving, 30 mm range noise
  const person = { x: 3, y: 0, r: 0.25, z0: -1, z1: 1 }, o = { floorZ: -50, B: 923 }, nf = 0.03;   // real beam step
  function setup() {
    const g = gridFor(o), cfg = defaultConfig(), truth = castRanges({ ...o, objects: [person] }), bg = castRanges(o);
    const noisy = castRanges({ ...o, objects: [person], noise: nf, seed: 7 });
    cfg.temporal.noiseFloor = nf;
    cfg.dynamic = { on: true, radius: 3 * nf, minPts: 4, gap: 0.3 };
    g.conf.fill(1); g.noiseVar.fill(nf * nf);
    for (let i = 0; i < g.N; i++) if (truth[i] > 0 && truth[i] < bg[i] - 0.5) g.motionHold[i] = 5;
    return { g, cfg, truth, bg, noisy };
  }
  const onPerson = (g: ReturnType<typeof gridFor>) => Array.from({ length: g.N }, (_, i) => i).filter(i => g.motionHold[i] > 0);

  it("dynSmooth reduces the noise of a moving body without pulling it towards the wall", () => {
    const { g, cfg, truth, bg, noisy } = setup(), out = noisy.slice();
    dynSmooth(g, noisy, out, bg, meta(o).step_deg, cfg);
    const all = onPerson(g), idx = all.filter(i => out[i] > 0);      // a few grazing edge outliers count as mixed pixels
    const err = (a: Float32Array) => Math.sqrt(idx.reduce((s, i) => s + (a[i] - truth[i]) ** 2, 0) / idx.length);
    expect(all.length).toBeGreaterThan(50);
    expect(idx.length).toBeGreaterThan(all.length * 0.98);
    expect(err(out)).toBeLessThan(err(noisy) / 2);
    const bias = idx.reduce((s, i) => s + out[i] - truth[i], 0) / idx.length;
    expect(Math.abs(bias)).toBeLessThan(0.01);
    expect(Math.max(...idx.map(i => out[i] - truth[i]))).toBeLessThan(0.1);   // no point drawn towards the wall
    for (let i = 0; i < g.N; i++) if (!g.motionHold[i]) expect(out[i]).toBe(noisy[i]);   // static beams untouched
  });

  it("dynSmooth drops a mixed pixel between the body and the wall, keeps the edge", () => {
    const { g, cfg, truth, bg } = setup(), clean = truth.slice(), l = 12, B = g.B;
    let edge = -1;                                              // last person beam of layer l, wall to its left
    for (let b = 1; b < B - 1; b++) { const i = l * B + b; if (g.motionHold[i] && !g.motionHold[i + 1]) edge = i; }
    const veil = edge + 1;
    clean[veil] = (truth[edge] + truth[veil + 1]) / 2;           // halfway between person and wall
    g.motionHold[veil] = 5;
    const out = clean.slice();
    expect(dynSmooth(g, clean, out, bg, meta(o).step_deg, cfg)).toBe(1);
    expect(out[veil]).toBe(0);
    expect(out[edge]).toBeGreaterThan(0);
  });

  it("bilateral leaves moving beams to dynSmooth", () => {
    const { g, cfg, noisy } = setup(), out = new Float32Array(g.N);
    bilateral(g, noisy, out, cfg);
    for (const i of onPerson(g)) expect(out[i]).toBe(noisy[i]);
  });

  it("metrics: roughness and foreground flicker of moving beams", () => {
    const { g, cfg, truth, bg, noisy } = setup();
    expect(movingRoughness(g, noisy, cfg)).toBeGreaterThan(3 * movingRoughness(g, truth, cfg));
    expect(movingRoughness(createGrid(2, 10), new Float32Array(20), cfg)).toBeNaN();
    const m = new FlickerMeter(g.N), model = { bg, cand: new Float32Array(g.N), stable: new Float32Array(g.N), ready: true };
    expect(m.update(g, truth, null, cfg)).toBeNaN();             // no background yet
    expect(m.update(g, truth, model, cfg)).toBeNaN();            // first scan
    expect(m.update(g, truth, model, cfg)).toBe(0);
    const gone = truth.slice();
    for (const i of onPerson(g).slice(0, 10)) gone[i] = bg[i];  // 10 beams fall back to the wall
    expect(m.update(g, gone, model, cfg)).toBeCloseTo(10 / onPerson(g).length);
  });
});

describe("radial cells", () => {
  const o = { floorZ: -50 };
  /** one scan: ranges of the scene with `objects`, their beams flagged moving; returns the cell output */
  function scan(c: Cells, g: ReturnType<typeof gridFor>, cfg: ReturnType<typeof defaultConfig>, objects: Cylinder[], k: number,
                drop: (i: number) => boolean = () => false) {
    const bg = castRanges(o), cur = castRanges({ ...o, objects });
    for (let i = 0; i < g.N; i++) {
      if (cur[i] < bg[i] - 0.3) g.motionHold[i] = 10;
      if (drop(i)) cur[i] = 0;
    }
    c.update(g, cur, 1000 + k / 10, cfg);
    const out = cur.slice();
    c.apply(g, cur, out, cfg);
    return { cur, out };
  }
  const shown = (g: ReturnType<typeof gridFor>, cur: Float32Array, out: Float32Array) => {
    let n = 0, all = 0;
    for (let i = 0; i < g.N; i++) if (g.motionHold[i] && cur[i] > 0) { all++; if (out[i] > 0) n++; }
    return n / Math.max(1, all);
  };
  function setup() {
    const g = gridFor(o), cfg = defaultConfig();
    cfg.cells = { ...cfg.cells, on: true };
    return { g, cfg, c: new Cells(g.L, g.B, cfg.cells.colBeams, cfg.cells.colLayers) };
  }
  const person = (y: number, x = 3): Cylinder => ({ x, y, r: 0.25, z0: -1, z1: 1 });

  it("a new object is shown after `confirm` hits, a one-scan spike never", () => {
    const { g, cfg, c } = setup();
    let r = scan(c, g, cfg, [person(0)], 0);
    expect(shown(g, r.cur, r.out)).toBe(0);
    r = scan(c, g, cfg, [person(0)], 1);
    expect(shown(g, r.cur, r.out)).toBe(1);
    g.motionHold.fill(0);
    r = scan(c, g, cfg, [person(0), { x: 1.8, y: -1.2, r: 0.05, z0: -0.4, z1: -0.2 }], 2);   // spike appears once
    const spike = Array.from({ length: g.N }, (_, i) => i).filter(i => r.cur[i] > 0 && r.cur[i] < 2.3);
    expect(spike.length).toBeGreaterThan(0);
    for (const i of spike) expect(r.out[i]).toBe(0);
  });

  it("the edge of a confirmed body moving into the next columns is shown at once", () => {
    const { g, cfg, c } = setup();
    for (let k = 0; k < 3; k++) scan(c, g, cfg, [person(0.05 * k)], k);
    const r = scan(c, g, cfg, [person(0.2)], 3);                 // sideways step into new columns
    expect(shown(g, r.cur, r.out)).toBe(1);
  });

  it("follows a body stepping 0.3 m along its column within one scan", () => {
    const { g, cfg, c } = setup();
    for (let k = 0; k < 4; k++) scan(c, g, cfg, [person(0)], k);
    const r = scan(c, g, cfg, [person(0, 2.7)], 4);
    expect(shown(g, r.cur, r.out)).toBe(1);
    const i = Array.from({ length: g.N }, (_, j) => j).find(j => c.assign[j] >= 0 && r.cur[j] < 2.6)!;
    expect(c.range[c.assign[i]]).toBeCloseTo(r.cur[i], 1);
  });

  it("fills a dropout for at most `hold` scans", () => {
    const { g, cfg, c } = setup();
    cfg.cells.hold = 2;
    for (let k = 0; k < 4; k++) scan(c, g, cfg, [person(0)], k);
    const hole = (i: number) => i % g.B % 3 === 0;              // every third beam column loses its return
    let k = 4;
    const holes = (r: { cur: Float32Array; out: Float32Array }) =>
      Array.from({ length: g.N }, (_, i) => i).filter(i => g.motionHold[i] && hole(i) && c.last[i] >= 0).map(i => r.out[i]);
    let r = scan(c, g, cfg, [person(0)], k++, hole);
    const filled = holes(r);
    expect(filled.length).toBeGreaterThan(10);
    expect(Math.min(...filled)).toBeGreaterThan(2.5);           // filled near the body's range (~2.75 m)
    r = scan(c, g, cfg, [person(0)], k++, hole);
    expect(Math.min(...holes(r))).toBeGreaterThan(2.5);
    r = scan(c, g, cfg, [person(0)], k++, hole);
    expect(Math.max(...holes(r))).toBe(0);                      // third scan: no longer held
  });
});

describe("remembered walls", () => {
  const o = { floorZ: -50 }, person = { x: 3, y: 0, r: 0.25, z0: -1, z1: 1 };
  const flag = (g: ReturnType<typeof gridFor>, D: Float32Array, bg: Float32Array) => {
    g.motionHold.fill(0);
    for (let i = 0; i < g.N; i++) if (D[i] > 0 && D[i] < bg[i] - 0.3) g.motionHold[i] = 5;
  };

  it("draws the wall behind a person who walks in front of it, and nothing once they are gone", () => {
    const g = gridFor(o), cfg = defaultConfig(), wall = castRanges(o), withPerson = castRanges({ ...o, objects: [person] });
    updateWall(g, wall, wall, cfg);                            // empty scene seen first
    flag(g, withPerson, wall);
    expect(wallFill(g, withPerson, wall, cfg, g.fill)).toBeGreaterThan(50);
    for (let i = 0; i < g.N; i++) {
      if (g.motionHold[i]) expect(g.fill[i]).toBeCloseTo(wall[i], 5);
      else expect(g.fill[i]).toBe(0);
    }
    g.motionHold.fill(0);                                      // standing still: not moving, still in front of the wall
    expect(wallFill(g, withPerson, wall, cfg, g.fill)).toBeGreaterThan(50);
    flag(g, wall, wall);
    expect(wallFill(g, wall, wall, cfg, g.fill)).toBe(0);
  });

  it("never remembers a person as wall, and forgets what the background later sees through", () => {
    const g = gridFor(o), cfg = defaultConfig(), wall = castRanges(o), withPerson = castRanges({ ...o, objects: [person] });
    updateWall(g, withPerson, wall, cfg);                      // person in front of the known empty scene: not adopted
    expect(Array.from(g.wall).filter((w, i) => w > 0 && w < wall[i] - 0.3)).toHaveLength(0);
    updateWall(g, withPerson, withPerson, cfg);                // background still thinks the person is the scene
    const i = Array.from({ length: g.N }, (_, j) => j).find(j => withPerson[j] < wall[j] - 0.3)!;
    expect(g.wall[i]).toBeCloseTo(withPerson[i], 5);
    updateWall(g, new Float32Array(g.N), wall, cfg);           // background learned the wall behind
    expect(g.wall[i]).toBeCloseTo(wall[i], 5);
  });
});

describe("clean outlines", () => {
  const o = { floorZ: -50 }, person = { x: 3, y: 0, r: 0.25, z0: -1, z1: 1 };
  const flag = (g: ReturnType<typeof gridFor>, D: Float32Array, bg: Float32Array) => {
    g.motionHold.fill(0);
    for (let i = 0; i < g.N; i++) if (D[i] > 0 && D[i] < bg[i] - 0.3) g.motionHold[i] = 5;
  };
  function setup() {
    const g = gridFor(o), cfg = defaultConfig(), wall = castRanges(o), withPerson = castRanges({ ...o, objects: [person] });
    for (let k = 0; k < WALL_N; k++) updateWall(g, wall, wall, cfg);   // the empty wall, seen for a while
    return { g, cfg, wall, withPerson };
  }

  it("a moving beam that sees its remembered wall is drawn as it, and refines a young memory", () => {
    const { g, cfg, wall } = setup(), noisy = castRanges({ ...o, noise: 0.02, seed: 4 });
    g.motionHold.fill(5);
    const out = noisy.slice();
    const valid = wall.filter(w => w > 0).length;
    expect(snapToWall(g, out, cfg, false)).toBeGreaterThan(valid * 0.99);    // all but > 3σ noise
    for (let i = 0; i < g.N; i++) if (out[i] !== noisy[i]) expect(out[i]).toBe(g.wall[i]);
    g.wall.set(noisy); g.wallN.fill(1);                         // a memory from one raw reading
    for (let k = 0; k < 15; k++) snapToWall(g, castRanges({ ...o, noise: 0.02, seed: 10 + k }), cfg, true);
    expect(rms(g.wall, wall)).toBeLessThan(rms(noisy, wall) / 2.5);
  });

  it("static outputs are averaged into the memory, a new surface replaces it", () => {
    const { g, cfg, wall } = setup();
    g.wall.set(castRanges({ ...o, noise: 0.02, seed: 2 })); g.wallN.fill(1);
    for (let k = 0; k < WALL_N; k++) updateWall(g, castRanges({ ...o, noise: 0.005, seed: 30 + k }), wall, cfg);
    expect(rms(g.wall, wall)).toBeLessThan(0.006);
    const moved = castRanges({ ...o, wallX: 5.5 });             // the wall moved back 0.5 m (a door opened)
    updateWall(g, moved, moved, cfg);
    expect(rms(g.wall, moved)).toBeLessThan(1e-6);
  });

  it("drops mixed pixels at the outline and marks the object for the mesh cut", () => {
    const { g, cfg, wall, withPerson } = setup(), D = withPerson.slice(), l = 12, B = g.B;
    let edge = -1;                                              // last person beam of layer l
    for (let b = 1; b < B - 1; b++) { const i = l * B + b; if (D[i] < wall[i] - 0.5 && D[i + 1] > wall[i + 1] - 0.1) edge = i; }
    D[edge + 1] = (D[edge] + wall[edge + 1]) / 2;               // halfway between the person and the wall
    expect(frontMask(g, D, wall, cfg, g.front)).toBeGreaterThan(50);
    expect(g.front[edge]).toBe(1);
    expect(g.front[edge + 1]).toBe(1);
    expect(dropMixed(g, D, g.front, cfg)).toBeGreaterThanOrEqual(1);
    expect(D[edge + 1]).toBe(0);
    expect(g.front[edge + 1]).toBe(DROPPED);
    flag(g, withPerson, wall);
    expect(wallFill(g, D, wall, cfg, g.fill)).toBeGreaterThan(0);
    expect(g.fill[edge + 1]).toBeCloseTo(wall[edge + 1], 2);   // the wall is drawn behind the dropped pixel
    const kept = Array.from({ length: g.N }, (_, i) => i).filter(i => withPerson[i] < wall[i] - 0.5 && D[i] > 0).length;
    const person = Array.from({ length: g.N }, (_, i) => i).filter(i => withPerson[i] < wall[i] - 0.5).length;
    expect(kept / person).toBeGreaterThan(0.95);                // the body itself stays
  });
});

describe("clean outlines: close to the wall", () => {
  const o = { floorZ: -50 };
  function setup() {
    const g = gridFor(o), cfg = defaultConfig(), wall = castRanges(o);
    for (let k = 0; k < WALL_N; k++) updateWall(g, wall, wall, cfg);
    return { g, cfg, wall };
  }
  const patch = (g: ReturnType<typeof gridFor>, l0: number, b0: number, n: number) =>
    Array.from({ length: n * n }, (_, k) => (l0 + ((k / n) | 0)) * g.B + b0 + (k % n));

  it("a moving patch just in front of the wall (feet on the floor) counts as in front, a lone noisy beam not", () => {
    const { g, cfg, wall } = setup(), D = wall.slice(), feet = patch(g, 5, 80, 3), lone = 12 * g.B + 140;
    for (const i of [...feet, lone]) { D[i] = wall[i] - 0.18; g.motionHold[i] = 5; }   // inside the detector's tolerance
    frontMask(g, D, wall, cfg, g.front);
    for (const i of feet) expect(g.front[i]).toBe(FRONT);
    expect(g.front[lone]).toBe(0);
    g.motionHold.fill(0);
    frontMask(g, D, wall, cfg, g.front);
    expect(g.front[feet[4]]).toBe(0);                           // not moving: that is just the wall's shape
  });

  it("a wall beam pulled towards the object next to it is put back onto the wall", () => {
    const { g, cfg, wall } = setup(), D = wall.slice(), body = patch(g, 10, 80, 4), next = 11 * g.B + 84;
    for (const i of body) { D[i] = 3; g.motionHold[i] = 5; }
    D[next] = wall[next] - 0.15;                               // within the foreground tolerance, but 15 cm off its wall
    frontMask(g, D, wall, cfg, g.front);
    expect(g.front[next]).toBe(0);
    dropMixed(g, D, g.front, cfg);
    expect(D[next]).toBe(g.wall[next]);
  });

  it("a remembered wall changes only after a new surface stayed for a while", () => {
    const { g, cfg, wall } = setup(), moved = castRanges({ ...o, wallX: 5.4 });
    for (let k = 1; k < WALL_CONFIRM; k++) { updateWall(g, moved, null, cfg); expect(rms(g.wall, wall)).toBeLessThan(1e-6); }
    updateWall(g, moved, null, cfg);
    expect(rms(g.wall, moved)).toBeLessThan(1e-6);
  });

  it("a remembered value that sticks out from its neighbours is drawn as their median", () => {
    const { g, cfg, wall } = setup(), i = 12 * g.B + 90, D = wall.slice();
    g.wall[i] = wall[i] - 0.3;                                 // remembered a mixed pixel
    D[i] = 2; g.motionHold[i] = 5;                              // something in front of it now
    frontMask(g, D, wall, cfg, g.front);
    wallFill(g, D, wall, cfg, g.fill);
    expect(Math.abs(g.fill[i] - wall[i])).toBeLessThan(0.01);
  });
});

describe("layer calibration", () => {
  it("removeUnobservable leaves no constant, linear or quadratic part", () => {
    const b = Float32Array.from({ length: 24 }, (_, l) => 0.01 + 0.002 * l + 0.0001 * l * l + 0.005 * Math.sin(l));
    removeUnobservable(b);
    for (const deg of [0, 1, 2]) {
      const dot = b.reduce((s, v, l) => s + v * ((l - 11.5) / 24) ** deg, 0);
      expect(Math.abs(dot)).toBeLessThan(1e-6);
    }
    expect(Math.max(...b.map(Math.abs))).toBeGreaterThan(0.002);   // the wavy part survives
  });

  it("learns injected per-layer offsets from a flat wall", () => {
    const offsets = Array.from({ length: 24 }, (_, l) => 0.02 * Math.sin(2 * Math.PI * l / 6));
    const g = gridFor({ B: 301, step: 0.4 });
    const D = castRanges({ B: 301, step: 0.4, layerOffsets: offsets, floorZ: -50 });
    const bias = new Float32Array(24);
    for (let k = 0; k < 30; k++) {
      const corrected = D.slice();
      applyLayerBias(g, corrected, bias);
      updateLayerBias(g, corrected, bias, 0.5);
    }
    const target = Float32Array.from(offsets, v => -v);
    removeUnobservable(target);
    const err = Math.max(...bias.map((v, l) => Math.abs(v - target[l])));
    expect(err).toBeLessThan(0.006);                            // from ±20 mm waves
  });
});

describe("processor", () => {
  it("runs the whole pipeline and resets", () => {
    const p = new Processor(defaultConfig());
    const m = meta();
    const o = { floorZ: -50 };
    for (let k = 0; k < 15; k++) p.ingest(frameData({ ...o, noise: 0.02, seed: k + 1, quantize: true }), { ...m, ts: 1000 + k / 10 });
    const g = p.grid!;
    expect(g.frames).toBe(15);
    expect(rms(g.out, castRanges(o))).toBeLessThan(0.006);            // from σ = 20 mm + 12.5 mm steps
    expect(p.stats.ingestMs).toBeGreaterThan(0);
    p.reset();
    expect(g.frames).toBe(0);
    expect(() => p.ingest(new Float32Array(10), m)).toThrow(/expected/);
    expect(elevations(24)[23]).toBeCloseTo(1.2);
  });
});
