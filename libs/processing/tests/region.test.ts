// The calibration region: a polygon from above outside of which calibration leaves everything out.
import { describe, expect, it } from "vitest";
import { gridCloud } from "../src/fusion/calib/icp";
import { checkRegion, cropToRegion, pointInPolygon, polygonSimple, type Region } from "../src/fusion/calib/region";
import { calibrateRig } from "../src/fusion/calib/rig";
import { poseError } from "../src/fusion/pose";
import { castScan, RIG3 } from "../sim/rig";
import { detections, EMPTY, rays, truth } from "../sim/calib";

const L_SHAPE: Region = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]];

describe("polygon", () => {
  it("tells inside from outside, concave included", () => {
    expect(pointInPolygon(0.5, 3, L_SHAPE)).toBe(true);
    expect(pointInPolygon(3, 0.5, L_SHAPE)).toBe(true);
    expect(pointInPolygon(3, 3, L_SHAPE)).toBe(false);     // in the notch
    expect(pointInPolygon(-1, 0.5, L_SHAPE)).toBe(false);
  });

  it("finds crossing edges", () => {
    expect(polygonSimple(L_SHAPE)).toBe(true);
    expect(polygonSimple([[0, 0], [2, 2], [2, 0], [0, 2]])).toBe(false);   // a bow tie
  });

  it("checks what a client sends", () => {
    expect(checkRegion([[0, 0], [1, 0], [0, 1]])).toEqual([[0, 0], [1, 0], [0, 1]]);
    expect(() => checkRegion([[0, 0], [1, 0]])).toThrow(/corners/);
    expect(() => checkRegion([[0, 0], [1, 0], [NaN, 1]])).toThrow(/metres/);
    expect(() => checkRegion([[0, 0], [1, 0], ["a", 1]])).toThrow(/metres/);
    expect(() => checkRegion([[0, 0], [2, 2], [2, 0], [0, 2]])).toThrow(/cross/);
    expect(() => checkRegion(null)).toThrow();
  });
});

describe("cropToRegion", () => {
  const inputs = RIG3.map((s, k) => {
    const { rx, ry, rz, L, B } = rays(s);
    return { data: { L, B, rayX: rx, rayY: ry, rayZ: rz, bg: castScan({ ...s, noise: 0.003 }, EMPTY, 0) }, walk: detections(s, 0, 40, k + 1), pose: truth(s) };
  });
  // the room's walls are at x -4…4.5; the region cuts the east strip off, the pillar and the east wall with it
  const region: Region = [[-5, -4], [3, -4], [3, 4], [-5, 4]];

  it("zeroes the beams and walk samples outside, and leaves the originals alone", () => {
    const before = inputs.map(i => i.data.bg.slice());
    const out = cropToRegion(inputs, region);
    expect(out.every(o => o.cut > 0)).toBe(true);
    expect(out.some(o => o.walk.length < inputs[out.indexOf(o)].walk.length)).toBe(true);
    inputs.forEach((i, k) => expect(i.data.bg).toEqual(before[k]));
    const c = out[1], p = inputs[1].pose;
    for (let i = 0; i < c.data.bg.length; i++) {
      const r = inputs[1].data.bg[i];
      if (!(r > 0)) continue;
      const x = p.R[0] * i0(inputs[1], i, r, 0) + p.R[1] * i0(inputs[1], i, r, 1) + p.R[2] * i0(inputs[1], i, r, 2) + p.t[0];
      expect(c.data.bg[i] > 0).toBe(x < 3);
    }
  });

  it("still calibrates on what is left", () => {
    const out = cropToRegion(inputs, region);
    const res = calibrateRig(out.map((o, k) => ({ name: RIG3[k].name, cloud: gridCloud(o.data.bg, o.data.rayX, o.data.rayY, o.data.rayZ, o.data.L, o.data.B), walk: o.walk })));
    RIG3.forEach((s, k) => { const e = poseError(res[k].pose, truth(s)); expect(e.dist, s.name).toBeLessThan(0.02); expect(e.angle, s.name).toBeLessThan(0.2); });
  });
});

/** component c of beam i at range r, sensor frame */
function i0(inp: { data: { rayX: Float32Array; rayY: Float32Array; rayZ: Float32Array } }, i: number, r: number, c: number): number {
  return [inp.data.rayX, inp.data.rayY, inp.data.rayZ][c][i] * r;
}
