import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/config";
import { createBackground, foreground, updateBackground } from "../src/objects/background";
import { DIM_BACKGROUND } from "../src/objects/detector";
import { kfInit, kfPredict, kfUpdate } from "../src/objects/kalman";
import { segment } from "../src/objects/segment";
import { boxCorners, isPersonLike, Tracker, trackLabel } from "../src/objects/tracker";
import { createGrid } from "../src/pipeline/grid";
import { Processor } from "../src/pipeline/processor";
import { updateRays } from "../src/pipeline/rays";
import { castRanges, frameData, meta, rng, type Cylinder } from "./helpers/scene";

describe("kalman", () => {
  it("estimates a constant velocity", () => {
    const k = kfInit(0, 0);
    for (let s = 1; s <= 30; s++) { kfPredict(k, 0.1); kfUpdate(k, 0.1 * s * 1.2, -0.1 * s * 0.5); }
    expect(k.vx).toBeCloseTo(1.2, 1);
    expect(k.vy).toBeCloseTo(-0.5, 1);
  });
});

describe("background", () => {
  it("adopts a farther surface fast, a nearer one only after `learn` s, never under a hold", () => {
    const c = { ...defaultConfig().objects, learn: 2 }, nv = new Float32Array(1), hold = new Uint8Array(1);
    const m = createBackground(1);
    updateBackground(m, Float32Array.of(3), nv, hold, 0.1, c);          // init with someone standing there
    for (let k = 0; k < 4; k++) updateBackground(m, Float32Array.of(5), nv, hold, 0.1, c);
    expect(m.bg[0]).toBe(5);                                             // revealed wall: 0.3 s
    for (let k = 0; k < 15; k++) updateBackground(m, Float32Array.of(2), nv, hold, 0.1, c);
    expect(m.bg[0]).toBe(5);                                             // 1.5 s < learn
    hold[0] = 1;
    for (let k = 0; k < 30; k++) updateBackground(m, Float32Array.of(2), nv, hold, 0.1, c);
    expect(m.bg[0]).toBe(5);                                             // held by a tracked object
    hold[0] = 0;
    updateBackground(m, Float32Array.of(2), nv, hold, 0.1, c);
    expect(m.bg[0]).toBe(2);                                             // released: absorbed
  });

  it("foreground = clearly in front of the background", () => {
    const c = defaultConfig().objects, m = createBackground(3);
    updateBackground(m, Float32Array.of(5, 5, 0), new Float32Array(3), new Uint8Array(3), 0.1, c);
    const out = new Uint8Array(3);
    expect(foreground(m, Float32Array.of(4.95, 3, 2), new Float32Array(3), new Uint8Array(3), c, out)).toBe(2);
    expect(Array.from(out)).toEqual([0, 1, 1]);
  });

  it("neighbourhood background: mixed pixels at a static edge and sporadic returns are not foreground", () => {
    const c = defaultConfig().objects, L = 3, B = 4, N = L * B, m = createBackground(N), nv = new Float32Array(N);
    // a near box (2 m) on the left two columns, the wall (5 m) on the right; beam 7 has "no return" as background
    const scene = Float32Array.from({ length: N }, (_, i) => (i % B < 2 ? 2 : 5));
    scene[7] = 0;
    updateBackground(m, scene, nv, new Uint8Array(N), 0.1, c);
    const cur = scene.slice(), out = new Uint8Array(N);
    cur[6] = 3.5;                                               // edge beam: a range between box and wall
    cur[7] = 4.95;                                              // a sporadic return from the wall
    foreground(m, cur, nv, new Uint8Array(N), c, out, { L, B });
    expect(out[6]).toBe(0);
    expect(out[7]).toBe(0);
    cur[6] = 1.2;                                               // something really in front of both
    foreground(m, cur, nv, new Uint8Array(N), c, out, { L, B });
    expect(out[6]).toBe(1);
    foreground(m, Float32Array.from(scene, (v, i) => (i === 7 ? 4.95 : v)), nv, new Uint8Array(N), c, out);
    expect(out[7]).toBe(1);                                     // without the grid: per beam, as before
  });
});

function segmentScene(objects: Cylinder[]) {
  const o = { objects }, m = meta(o), g = createGrid(m.layers, m.beams);
  g.elev.set(frameData(o).subarray(2 * g.N));
  updateRays(g, m.start_azimuth_deg, m.step_deg, "upright");
  const empty = castRanges(), cur = castRanges(o), fg = new Uint8Array(g.N);
  for (let i = 0; i < g.N; i++) fg[i] = cur[i] > 0 && cur[i] < empty[i] - 0.2 ? 1 : 0;
  return segment({ ...g, stepDeg: m.step_deg }, cur, fg, defaultConfig().objects, new Int32Array(g.N), new Int32Array(g.N));
}

describe("segmentation", () => {
  it("drops the mixed-pixel fringe at a person's outline instead of making it an object", () => {
    const o = { objects: [{ x: 2.8, y: 0, r: 0.25, z0: -1, z1: 0.8 }] }, m = meta(o), g = createGrid(m.layers, m.beams);
    g.elev.set(frameData(o).subarray(2 * g.N));
    updateRays(g, m.start_azimuth_deg, m.step_deg, "upright");
    const empty = castRanges(), cur = castRanges(o), fg = new Uint8Array(g.N);
    let edge = -1;                                              // a short column just beside the person
    for (let b = 1; b < g.B; b++) { const i = 12 * g.B + b; if (cur[i] < empty[i] - 0.5 && cur[i + 1] > empty[i + 1] - 0.1) edge = i + 1; }
    for (let l = 10; l <= 14; l++) cur[l * g.B + (edge % g.B)] = (2.8 + empty[edge]) / 2;   // between person and wall
    for (let i = 0; i < g.N; i++) fg[i] = cur[i] > 0 && cur[i] < empty[i] - 0.2 ? 1 : 0;
    const c = { ...defaultConfig().objects, minPoints: 3 };
    const { detections } = segment({ ...g, stepDeg: m.step_deg }, cur, fg, c, new Int32Array(g.N), new Int32Array(g.N));
    expect(detections).toHaveLength(1);
  });

  it("separates two people and measures their boxes", () => {
    const { detections } = segmentScene([{ x: 3, y: 1, r: 0.25, z0: -1, z1: 0.8 }, { x: 3, y: -1, r: 0.25, z0: -1, z1: 0.8 }]);
    expect(detections).toHaveLength(2);
    for (const d of detections) {
      expect(Math.abs(Math.abs(d.y) - 1)).toBeLessThan(0.2);
      expect(d.x).toBeGreaterThan(2.7); expect(d.x).toBeLessThan(3.1);
      expect(d.wid).toBeLessThan(0.6);
      expect(d.hgt).toBeGreaterThan(0.5);
    }
  });

  it("keeps a small object mostly hidden behind a person (not taken for a fringe)", () => {
    // 4 beams wide and short: well under the fixed size limit for fringes (80 beams) it once had, which
    // dropped it. Fringes are judged by thickness (mixed pixels are 1–3 beams thick), not by size.
    const hidden: Cylinder = { x: 3.6, y: 0.35, r: 0.25, z0: -1, z1: -0.3 };
    const visible = castRanges({ objects: [{ x: 2, y: 0, r: 0.25, z0: -1, z1: 0.8 }, hidden] }).filter(v => v > 3.2 && v < 3.7).length;
    expect(visible).toBeLessThan(80);
    const { detections } = segmentScene([{ x: 2, y: 0, r: 0.25, z0: -1, z1: 0.8 }, hidden]);
    expect(detections).toHaveLength(2);
    expect(detections.some(d => d.x > 3.2)).toBe(true);
  });

  it("keeps a person next to an object apart, merges close fragments", () => {
    expect(segmentScene([{ x: 2.5, y: 0.6, r: 0.2, z0: -1, z1: 0.8 }, { x: 2.5, y: -0.6, r: 0.3, z0: -1, z1: 0.3 }]).detections).toHaveLength(2);
    // a person in front of a big object: the person's shadow may split the object behind, never the person
    const occl = segmentScene([{ x: 2, y: 0, r: 0.2, z0: -1, z1: 0.8 }, { x: 4, y: 0, r: 0.6, z0: -1, z1: 0.5 }]).detections;
    expect(occl.filter(d => d.x < 2.5)).toHaveLength(1);
    // two legs 0.2 m apart = one object
    expect(segmentScene([{ x: 3, y: 0.12, r: 0.07, z0: -1, z1: 0.8 }, { x: 3, y: -0.12, r: 0.07, z0: -1, z1: 0.8 }]).detections).toHaveLength(1);
  });
});

describe("tracker", () => {
  const det = (x: number, y: number, hgt = 1.2) => ({ segments: [], n: 50, x, y, z: 0, bx: x, by: y, len: 0.4, wid: 0.3, hgt, yaw: 0,
    z0: -1, z1: -1 + hgt, l0: 3, l1: 20, b0: 0, b1: 5, clipped: false });

  it("confirms after 3 hits, keeps the id while moving, coasts, then drops", () => {
    const c = defaultConfig().objects, t = new Tracker();
    for (let k = 0; k < 20; k++) t.update([det(2 + 0.1 * k, 0)], 0.1, c);
    expect(t.tracks).toHaveLength(1);
    const tr = t.tracks[0];
    expect(tr.confirmed && tr.moved).toBe(true);
    expect(tr.cls).toBe("person");
    expect(tr.speed).toBeCloseTo(1, 0);
    expect(trackLabel(tr)).toMatch(/^#1 person · 1\.\d m\/s/);
    expect(boxCorners(tr)).toHaveLength(8);
    for (let k = 0; k < c.coast; k++) t.update([], 0.1, c);
    expect(t.tracks).toHaveLength(1);
    t.update([], 0.1, c);
    expect(t.tracks).toHaveLength(0);
  });

  it("tentative tracks die after one miss; far detections start new tracks", () => {
    const c = defaultConfig().objects, t = new Tracker();
    t.update([det(2, 0)], 0.1, c);
    t.update([], 0.1, c);
    expect(t.tracks).toHaveLength(0);
    t.update([det(2, 0), det(5, 2)], 0.1, c);
    t.update([det(2, 0), det(5, 2)], 0.1, c);
    expect(new Set(t.tracks.map(x => x.id)).size).toBe(2);
  });

  it("objects that never move become static after `learn` s", () => {
    const c = { ...defaultConfig().objects, learn: 1 }, t = new Tracker();
    for (let k = 0; k < 15; k++) t.update([det(3, 1, 0.5)], 0.1, c);
    expect(t.tracks[0].static).toBe(true);
    expect(t.tracks[0].cls).toBe("static object");
  });

  it("person rule", () => {
    expect(isPersonLike(det(1, 1, 1.2), false)).toBe(true);
    expect(isPersonLike(det(1, 1, 0.5), false)).toBe(false);
    expect(isPersonLike(det(1, 1, 0.5), true)).toBe(true);
    expect(isPersonLike({ ...det(1, 1), len: 2 }, true)).toBe(false);
    expect(isPersonLike({ ...det(1, 1), len: 1.5 }, true)).toBe(true);    // arms stretched out
  });
});

describe("person label", () => {
  const det = (x: number, len = 0.4) => ({ segments: [], n: 50, x, y: 0, z: 0, bx: x, by: 0, len, wid: 0.3, hgt: 1.2, yaw: 0,
    z0: -1, z1: 0.2, l0: 3, l1: 20, b0: 0, b1: 5, clipped: false });
  it("holds through a short gesture (hysteresis), drops after a lasting change", () => {
    const c = defaultConfig().objects, t = new Tracker();
    for (let k = 0; k < 15; k++) t.update([det(2 + 0.1 * k)], 0.1, c);
    expect(t.tracks[0].cls).toBe("person");
    for (let k = 0; k < 2; k++) t.update([det(3.5 + 0.1 * k, 2.2)], 0.1, c);   // 2 scans too long for a person
    expect(t.tracks[0].cls).toBe("person");
    for (let k = 0; k < 6; k++) t.update([det(3.7 + 0.1 * k, 2.2)], 0.1, c);
    expect(t.tracks[0].cls).toBe("moving object");
  });
});

describe("detector in the pipeline", () => {
  it("tracks one walking person with a stable id and no false objects", () => {
    const p = new Processor(defaultConfig()), m = meta();
    for (let k = 0; k < 30; k++) p.ingest(frameData({ noise: 0.01, seed: k + 1, quantize: true }), { ...m, ts: 1000 + k * 0.1 });
    const ids = new Set<number>();
    let confirmedFrames = 0;
    for (let k = 0; k < 40; k++) {                     // walks from (2, 1.5) to (2, −1.5) at 0.75 m/s
      const person: Cylinder = { x: 2.5, y: 1.5 - 0.075 * k, r: 0.22, z0: -1, z1: 0.9 };
      p.ingest(frameData({ noise: 0.01, seed: 100 + k, quantize: true, objects: [person] }), { ...m, ts: 1003 + k * 0.1 });
      const conf = p.objects!.confirmed;
      expect(conf.length).toBeLessThanOrEqual(1);
      if (conf.length) { confirmedFrames++; ids.add(conf[0].id); }
    }
    expect(confirmedFrames).toBeGreaterThan(30);
    expect(ids.size).toBe(1);
    const t = p.objects!.confirmed[0];
    expect(t.cls).toBe("person");
    expect(t.speed).toBeGreaterThan(0.5); expect(t.speed).toBeLessThan(1.0);
    expect(Math.abs(t.y - (1.5 - 0.075 * 39))).toBeLessThan(0.3);
    // highlighting: the person's beams in its colour, the rest dimmed
    const det = p.objects!, i = det.cell.findIndex(v => v === t.id);
    expect(det.tint(i, [1, 1, 1], { selected: 0, dimBackground: true })).toEqual(t.color);
    const bgI = det.cell.findIndex(v => v === 0);
    expect(det.tint(bgI, [1, 1, 1], { selected: 0, dimBackground: true })).toEqual([DIM_BACKGROUND, DIM_BACKGROUND, DIM_BACKGROUND]);
  });

  // scenes the recordings do not contain, so the rules are checked against cases they were not tuned on
  it("no ghosts at a static pillar with mixed-pixel edges or at a dark wall patch; one track for a person walking in", () => {
    const p = new Processor(defaultConfig()), m = meta(), r = rng(7);
    const pillar: Cylinder = { x: 3, y: -1.2, r: 0.15, z0: -1, z1: 2 }, B = m.beams;
    const clean = castRanges({ objects: [pillar] }), empty = castRanges();
    const edges: number[] = [];                                 // beams on both sides of the pillar's silhouette
    for (let i = 1; i < clean.length - 1; i++) {
      const on = clean[i] < empty[i] - 0.5, l = (i / B) | 0;
      if (on !== (clean[i + 1] < empty[i + 1] - 0.5) && ((i + 1) / B | 0) === l) edges.push(i, i + 1);
    }
    expect(edges.length).toBeGreaterThan(10);
    const frame = (k: number, objects: Cylinder[]) => {
      const f = frameData({ noise: 0.01, seed: 500 + k, quantize: true, objects: [pillar, ...objects] });
      for (const i of edges) if (r() < 0.5) f[i] = clean[i] + r() * (empty[i] - clean[i]);   // mixed pixels
      for (let l = 14; l <= 18; l++) for (let b = 120; b <= 140; b++) if (r() > 0.3) f[l * B + b] = 0;   // dark: 30 % returns
      return f;
    };
    for (let k = 0; k < 80; k++) {
      p.ingest(frame(k, []), { ...m, ts: 1000 + k * 0.1 });
      if (k >= 20) expect(p.objects!.confirmed.map(t => `${t.cls} at ${t.x.toFixed(1)}, ${t.y.toFixed(1)}`)).toEqual([]);
    }
    let seen = 0;
    for (let k = 0; k < 30; k++) {
      const person: Cylinder = { x: 2.2, y: 1.2 - 0.06 * k, r: 0.22, z0: -1, z1: 0.9 };
      p.ingest(frame(80 + k, [person]), { ...m, ts: 1008 + k * 0.1 });
      expect(p.objects!.confirmed.length).toBeLessThanOrEqual(1);
      seen += p.objects!.confirmed.length;
    }
    expect(seen).toBeGreaterThan(20);
  });

  it("finds a person far away (8 m)", () => {
    const p = new Processor(defaultConfig()), m = meta(), o = { wallX: 12 };
    for (let k = 0; k < 30; k++) p.ingest(frameData({ ...o, noise: 0.01, seed: k + 1, quantize: true }), { ...m, ts: 1000 + k * 0.1 });
    for (let k = 0; k < 20; k++) {
      const person: Cylinder = { x: 8, y: 0.8 - 0.08 * k, r: 0.22, z0: -1, z1: 0.9 };
      p.ingest(frameData({ ...o, noise: 0.01, seed: 50 + k, quantize: true, objects: [person] }), { ...m, ts: 1003 + k * 0.1 });
    }
    const conf = p.objects!.confirmed;
    expect(conf).toHaveLength(1);
    expect(Math.abs(conf[0].x - 8)).toBeLessThan(0.4);
  });

  it("does not dim anything while no object is tracked", () => {
    const p = new Processor(defaultConfig());
    p.ingest(frameData(), meta());
    expect(p.objects!.tint(0, [1, 1, 1], { selected: 0, dimBackground: true })).toEqual([1, 1, 1]);
  });

  it("turning detection off clears everything", () => {
    const cfg = defaultConfig(), p = new Processor(cfg), m = meta();
    p.ingest(frameData(), m);
    p.ingest(frameData({ objects: [{ x: 2, y: 0, r: 0.3, z0: -1, z1: 1 }] }), { ...m, ts: 1000.1 });
    cfg.objects.on = false;
    p.ingest(frameData(), { ...m, ts: 1000.2 });
    expect(p.objects!.tracks).toHaveLength(0);
    expect(p.objects!.bgModel.ready).toBe(false);
  });
});
