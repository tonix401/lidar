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
import { castRanges, frameData, meta, type Cylinder } from "./helpers/scene";

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
