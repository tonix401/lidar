// Per-browser settings (src/ui/storage.ts): a blocked or full storage only means defaults.
import { describe, expect, it } from "vitest";
import { Store } from "../src/ui/storage";

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
