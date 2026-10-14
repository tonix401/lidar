import { describe, expect, it } from "vitest";
import { css, hsl2rgb, packABGR, trackColor, turbo } from "../src/core/colors";
import { fmtMB, fmtTime, shortError } from "../src/core/format";
import { median, popcount, sameTol, smallestEigenvector } from "../src/core/math";

describe("math", () => {
  it("popcount", () => {
    expect(popcount(0)).toBe(0);
    expect(popcount(0b1011)).toBe(3);
    expect(popcount(0xffffffff)).toBe(32);
  });

  it("sameTol grows with range", () => expect(sameTol(10, 0.1, 0.02)).toBeCloseTo(0.3));

  it("smallestEigenvector finds a plane normal and its flatness", () => {
    // points on the plane z = 0.5x (normal ∝ (−0.5, 0, 1)) with a tiny bit of thickness
    const pts: number[][] = [];
    for (let x = -1; x <= 1; x += 0.25) for (let y = -1; y <= 1; y += 0.25) pts.push([x, y, 0.5 * x + ((x * 7 + y * 3) % 2 ? 0.001 : -0.001)]);
    const n = pts.length, m = [0, 1, 2].map(k => pts.reduce((s, p) => s + p[k], 0) / n);
    const cov = (a: number, b: number) => pts.reduce((s, p) => s + (p[a] - m[a]) * (p[b] - m[b]), 0) / n;
    const out = [0, 0, 0];
    const v = smallestEigenvector(cov(0, 0), cov(0, 1), cov(0, 2), cov(1, 1), cov(1, 2), cov(2, 2), out);
    const expected = [-0.5, 0, 1].map(c => c / Math.hypot(0.5, 1));
    expect(Math.abs(out[0] * expected[0] + out[1] * expected[1] + out[2] * expected[2])).toBeCloseTo(1, 4);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1e-4);
    expect(smallestEigenvector(0, 0, 0, 0, 0, 0, out)).toBe(-1);
  });

  it("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNaN();
  });
});

describe("colors", () => {
  it("turbo is clamped, dark at 0, red at 1", () => {
    expect(turbo(-1)).toEqual(turbo(0));
    expect(turbo(0).reduce((a, b) => a + b)).toBeLessThan(0.5);
    const [r1, , b1] = turbo(2);
    expect(r1).toBeGreaterThan(b1 + 0.3);
    for (const c of [...turbo(0.3), ...turbo(0.7)]) { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(1); }
  });

  it("hsl and track colours", () => {
    expect(hsl2rgb(0, 1, 0.5).map(v => +v.toFixed(3))).toEqual([1, 0, 0]);
    expect(trackColor(1)).not.toEqual(trackColor(2));
  });

  it("css and packABGR", () => {
    expect(css([1, 0, 0])).toBe("rgb(255,0,0)");
    expect(css([0, 0, 1], 0.5)).toBe("rgba(0,0,255,0.5)");
    expect(packABGR([1, 0, 0])).toBe(0xff0000ff);
  });
});

describe("format", () => {
  it("time and size", () => {
    expect(fmtTime(125.4)).toBe("2:05");
    expect(fmtTime(undefined)).toBe("0:00");
    expect(fmtMB(5_300_000)).toBe("5.3 MB");
    expect(fmtMB(132_666_283)).toBe("133 MB");
  });
  it("shortError keeps the first line", () => {
    expect(shortError(new Error("boom\nstack"))).toBe("boom");
    expect(shortError("x".repeat(300)).length).toBe(160);
  });
});
