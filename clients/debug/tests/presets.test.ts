// The user's named filter settings, kept in the browser (src/ui/presets.ts).
import { describe, expect, it } from "vitest";
import { defaultConfig } from "@mrs6000/processing/config/config";
import { ConfigState } from "@mrs6000/processing/config/state";
import { UserPresets } from "../src/ui/presets";
import { KEYS, Store } from "../src/ui/storage";

const memory = () => { const m = new Map<string, string>(); return { m, store: new Store({ getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: k => void m.delete(k) }) }; };

describe("UserPresets", () => {
  it("saves, lists sorted, loads back into a ConfigState, removes, and keeps what it saved", () => {
    const { store } = memory(), p = new UserPresets(store), s = new ConfigState();
    s.setMode("manual");
    s.changeParam("temporal", "window", 23);
    expect(p.save("  Quiet room ", s)).toBe("Quiet room");
    s.changeParam("temporal", "window", 5);                  // later changes do not leak into the saved one
    p.save("alpha", s);
    expect(p.names()).toEqual(["alpha", "Quiet room"]);
    const t = new ConfigState();
    t.load(p.get("Quiet room"));
    expect([t.mode, t.cfg.temporal.window]).toEqual(["manual", 23]);
    p.remove("alpha");
    expect(p.names()).toEqual(["Quiet room"]);
    expect(p.get("alpha")).toBeNull();
    expect(new UserPresets(store).names()).toEqual(["Quiet room"]);   // it is in the storage, not just in this object
  });

  it("replaces a preset of the same name", () => {
    const p = new UserPresets(memory().store), s = new ConfigState({ mode: "manual" });
    p.save("a", s);
    s.changeParam("temporal", "window", 31);
    p.save("a", s);
    expect(p.names()).toEqual(["a"]);
    expect(new ConfigState(p.get("a")).cfg.temporal.window).toBe(31);
  });

  it("refuses empty, long and built-in names", () => {
    const p = new UserPresets(memory().store), s = new ConfigState();
    expect(() => p.save("   ", s)).toThrow(/name/);
    expect(() => p.save("x".repeat(41), s)).toThrow(/at most/);
    for (const n of ["medium", "Off", "custom"]) expect(() => p.save(n, s)).toThrow(/built-in/);
    expect(p.names()).toEqual([]);
  });

  it("loads a preset from an older version with stages missing or unknown, and ignores garbage storage", () => {
    const { m, store } = memory(), p = new UserPresets(store);
    m.set(KEYS.presets, JSON.stringify({ old: { mode: "manual", manual: { temporal: { window: 9, gone: 1 }, nonsense: {} } }, bad: 3 }));
    expect(p.names()).toEqual(["old"]);
    const s = new ConfigState(p.get("old"));
    expect(s.cfg.temporal.window).toBe(9);
    expect(s.cfg.spatial).toEqual(defaultConfig().spatial);
    for (const junk of ["{", "[]", "7", "null"]) { m.set(KEYS.presets, junk); expect(p.names()).toEqual([]); }
  });

  it("does not throw on a broken storage", () => {
    const broken = new Store({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("x"); } });
    const p = new UserPresets(broken);
    expect(p.names()).toEqual([]);
    expect(() => p.save("a", new ConfigState())).not.toThrow();
  });
});
