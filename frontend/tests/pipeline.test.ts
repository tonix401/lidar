import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/config";
import { bilateral } from "../src/pipeline/bilateral";
import { createGrid, resetHistory } from "../src/pipeline/grid";
import { historyFilter } from "../src/pipeline/history";
import { intensityFilter, rssiHistogram } from "../src/pipeline/intensity";
import { applyLayerBias, removeUnobservable, updateLayerBias } from "../src/pipeline/layercal";
import { detectMotion } from "../src/pipeline/motion";
import { rejectOutliers } from "../src/pipeline/outlier";
import { flattenPlanes } from "../src/pipeline/planes";
import { Processor } from "../src/pipeline/processor";
import { updateRays } from "../src/pipeline/rays";
import { temporalUpdate } from "../src/pipeline/temporal";
import { castRanges, elevations, frameData, meta } from "./helpers/scene";

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
