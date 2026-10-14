import { describe, expect, it } from "vitest";
import { autoConfig, estimateNoise } from "../src/config/auto";
import { defaultConfig, fmtParam, matchingPreset, mergeConfig, PRESETS, STAGES, withPreset } from "../src/config/config";
import { Store } from "../src/config/storage";
import { createGrid } from "../src/pipeline/grid";

describe("config", () => {
  it("every stage parameter exists in the default config", () => {
    const cfg = defaultConfig() as unknown as Record<string, Record<string, unknown>>;
    for (const s of STAGES) for (const p of s.params) expect(typeof cfg[s.key][p.k], `${s.key}.${p.k}`).toBe("number");
  });

  it("presets round-trip and leave non-preset stages alone", () => {
    const base = defaultConfig();
    expect(matchingPreset(base)).toBe("medium");
    const strong = withPreset({ ...base, objects: { ...base.objects, learn: 99 } }, "strong");
    expect(matchingPreset(strong)).toBe("strong");
    expect(strong.objects.learn).toBe(99);
    expect(strong.temporal.window).toBe(PRESETS.strong.temporal.window);
    strong.planes.wb = 11;
    expect(matchingPreset(strong)).toBe("custom");
    expect(PRESETS.off.temporal.on).toBe(false);
  });

  it("off switches every stage that changes ranges off, the others switch the default ones back on", () => {
    const off = withPreset(defaultConfig(), "off");
    for (const k of ["intensity", "layercal", "adaptive", "cells", "walls", "outlier", "temporal", "spatial", "planes", "outline"] as const)
      expect(off[k].on, k).toBe(false);
    expect(off.objects.on).toBe(true);                         // detection doesn't change the ranges
    expect(matchingPreset(off)).toBe("off");
    expect(matchingPreset({ ...off, layercal: { ...off.layercal, on: true } })).toBe("custom");
    const med = withPreset(off, "medium");
    expect(med.layercal.on && med.adaptive.on && med.walls.on).toBe(true);
    expect(med.cells.on || med.intensity.on).toBe(false);
    expect(matchingPreset(med)).toBe("medium");
  });

  it("auto mode keeps the user's clean-outlines switch and tunes its margin", () => {
    const base = defaultConfig();
    base.outline.on = false;
    expect(autoConfig(base, 0.03).outline).toEqual({ on: false, margin: 0.12 });
  });

  it("mergeConfig keeps only known keys of the right type", () => {
    const m = mergeConfig(defaultConfig(), { temporal: { window: 33, k: "x", bogus: 1 }, nope: {}, objects: null });
    expect(m.temporal.window).toBe(33);
    expect(m.temporal.k).toBe(defaultConfig().temporal.k);
    expect("bogus" in m.temporal).toBe(false);
    expect(mergeConfig(defaultConfig(), "garbage")).toEqual(defaultConfig());
  });

  it("fmtParam", () => {
    expect(fmtParam({ k: "a", label: "", min: 0, max: 1, step: 1, unit: " m" }, 3)).toBe("3 m");
    expect(fmtParam({ k: "a", label: "", min: 0, max: 1, step: 0.005, pct: true }, 0.02)).toBe("+2.0 % of range");
    expect(fmtParam({ k: "a", label: "", min: 0, max: 1, step: 0.001 }, 0.012)).toBe("0.012");
    expect(fmtParam({ k: "a", label: "", min: 0, max: 1, step: 0.001 }, 0.0123)).toBe("0.0123");   // typed in: all digits
  });

  it("auto config scales tolerances with the noise floor and keeps user stages", () => {
    const base = defaultConfig();
    base.objects.learn = 42;
    const a = autoConfig(base, 0.04);
    expect(a.temporal.noiseFloor).toBe(0.04);
    expect(a.outlier.abs).toBeCloseTo(0.2);
    expect(a.objects.learn).toBe(42);
    expect(a.dynamic.radius).toBeCloseTo(0.12);                // 3 × noise floor
    expect(autoConfig(base, 0.012).dynamic.radius).toBe(0.04);
    expect(a.outline.margin).toBeCloseTo(0.16);                // 4 × noise floor
    expect(PRESETS.off.outline.on).toBe(false);
  });

  it("the moving-area stages are part of the presets and survive old stored settings", () => {
    expect(PRESETS.off.dynamic.on).toBe(false);
    expect(PRESETS.strong.dynamic.radius).toBeGreaterThan(PRESETS.light.dynamic.radius);
    const old = mergeConfig(defaultConfig(), { temporal: { window: 7 } });   // stored before the stages existed
    expect(old.dynamic).toEqual(defaultConfig().dynamic);
    expect(old.cells).toEqual(defaultConfig().cells);
    expect(STAGES.findIndex(s => s.key === "dynamic")).toBeLessThan(STAGES.findIndex(s => s.key === "planes"));
    expect(defaultConfig().cells.on).toBe(false);                // experimental, user-controlled
    const base = defaultConfig();
    base.cells.on = true;
    expect(autoConfig(base, 0.03).cells.on).toBe(true);
    expect(withPreset(base, "light").cells.on).toBe(true);    // presets other than off leave opt-in stages alone
    expect(withPreset(base, "off").cells.on).toBe(false);     // off = raw
  });

  it("estimateNoise needs enough established beams", () => {
    const g = createGrid(4, 200);
    expect(estimateNoise(g)).toBeNull();
    g.frames = 20;
    g.nAvg.fill(10); g.temporal.fill(3); g.noiseVar.fill(0.025 ** 2);
    const est = estimateNoise(g)!;
    expect(est.noise).toBeCloseTo(0.025);
    g.noiseVar.fill(1);
    expect(estimateNoise(g)!.noise).toBe(0.08);         // clamped
  });
});

describe("storage", () => {
  it("survives a broken storage backend", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("x"); } };
    const s = new Store(broken);
    expect(s.get("a")).toBeNull();
    expect(() => s.set("a", "b")).not.toThrow();
    expect(() => s.remove("a")).not.toThrow();
  });
  it("json helpers", () => {
    const m = new Map<string, string>();
    const s = new Store({ getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: k => void m.delete(k) });
    s.setJson("k", { a: 1 });
    expect(s.json("k")).toEqual({ a: 1 });
    s.set("bad", "{");
    expect(s.json("bad")).toBeNull();
  });
});
