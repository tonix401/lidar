import { describe, expect, it } from "vitest";
import { defaultConfig, matchingPreset } from "../src/config/config";
import { ConfigState } from "../src/config/state";
import { Processor } from "../src/pipeline/processor";
import { statRows } from "../src/ui/statRows";
import { frameData, meta } from "./helpers/scene";

describe("ConfigState", () => {
  it("starts in auto mode from defaults; ignores garbage", () => {
    for (const stored of [undefined, null, "x", { mode: "weird", manual: 3 }]) {
      const s = new ConfigState(stored);
      expect(s.mode).toBe("auto");
      expect(s.manual).toEqual(defaultConfig());
    }
  });

  it("round-trips through JSON", () => {
    const s = new ConfigState();
    s.setMode("manual");
    s.changeParam("temporal", "window", 23);
    const t = new ConfigState(JSON.parse(JSON.stringify(s)));
    expect(t.mode).toBe("manual");
    expect(t.cfg.temporal.window).toBe(23);
  });

  it("manual: every change is remembered; intensity keeps min ≤ max", () => {
    const s = new ConfigState({ mode: "manual" });
    s.changeParam("intensity", "min", 300);
    s.changeParam("intensity", "max", 100);
    expect(s.cfg.intensity).toMatchObject({ min: 100, max: 100 });
    expect(s.manual.intensity).toEqual(s.cfg.intensity);
    s.applyPreset("strong");
    expect(matchingPreset(s.manual)).toBe("strong");
    s.resetStage("intensity");
    expect(s.cfg.intensity).toEqual(defaultConfig().intensity);
  });

  it("auto: only the user's stages and toggles are remembered, and they survive auto-tuning", () => {
    const s = new ConfigState();
    s.changeParam("objects", "learn", 50);             // auto: "user"
    s.changeParam("outline", "on", false);             // auto: "toggle"
    s.changeParam("temporal", "window", 3);            // auto: "tuned" (the panel doesn't allow it; not remembered)
    expect(s.manual.objects.learn).toBe(50);
    expect(s.manual.outline.on).toBe(false);
    expect(s.manual.temporal.window).toBe(defaultConfig().temporal.window);
    s.autoTune(null);
    expect(s.cfg.objects.learn).toBe(50);
    expect(s.cfg.outline.on).toBe(false);
    s.setMode("manual");
    expect(s.cfg.objects.learn).toBe(50);
  });

  it("resetAll restores every stage, the opt-in ones too", () => {
    const s = new ConfigState({ mode: "manual" });
    s.changeParam("cells", "on", true);
    s.changeParam("planes", "wb", 9);
    s.resetAll();
    expect(s.cfg).toEqual(defaultConfig());
  });

  it("auto-tunes from the measured noise once enough beams are known", () => {
    const s = new ConfigState(), p = new Processor(s.cfg);
    for (let k = 0; k < 15; k++) p.ingest(frameData({ noise: 0.03, seed: k + 1 }), meta({}, { ts: 1000 + k * 0.1 }));
    s.autoTune(p.grid);
    expect(s.estimate?.noise).toBeGreaterThan(0.012);
    expect(s.cfg.temporal.noiseFloor).toBe(s.estimate!.noise);
  });
});

describe("statRows", () => {
  it("lists only what applies", () => {
    const p = new Processor(defaultConfig());
    p.ingest(frameData({ noise: 0.01 }), meta());
    const base = { stats: p.stats, cfg: p.cfg, estimate: null, objects: p.objects, tracks: [], view: "3d" as const,
                   draw: "surface+points" as const, rendersPerSec: 10, triangles: 1234 };
    const rows = statRows(base);
    expect(rows.Timing.map(r => r[0])).toEqual(["Processing", "Renders / s", "Triangles"]);
    expect(rows.Scene).toEqual([]);
    expect(rows["Removed by filters"].map(r => r[0])).toEqual(["Outliers", "Flicker", "Mixed pixels", "At outlines"]);
    expect(rows.Objects[0]).toEqual(["Objects", "0 (0 people)"]);
    expect(statRows({ ...base, cfg: { ...p.cfg, objects: { ...p.cfg.objects, on: false } } }).Objects).toEqual([]);
    const top = statRows({ ...base, view: "top", estimate: { noise: 0.021, samples: 500, movingShare: 0.05 } });
    expect(top.Timing.map(r => r[0])).toEqual(["Processing"]);
    expect(top.Scene[0][1]).toBe("21 mm");
  });
});
