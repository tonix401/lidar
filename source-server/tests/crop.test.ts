// Cutting the beams outside a sensor's region from the scans it sends, and storing the region in the rig.
import { describe, expect, it } from "vitest";
import { Crop } from "../src/crop";
import { mergeRig } from "../src/rig";
import type { Header } from "@mrs6000/wire/frame";

const hdr: Header = { layers: 1, beams: 3, start_azimuth_deg: -30, step_deg: 30, elev: [0, 0, 0] };   // at -30°, 0° and 30°
const pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
const frame = () => ({ t: 1, d: Uint16Array.from([320, 320, 320]), r: Uint16Array.from([5, 6, 7]) });   // 4 m each

describe("Crop", () => {
  const strip: [number, number][] = [[0, -1], [5, -1], [5, 1], [0, 1]];

  it("zeroes the beams whose point is outside the region, and keeps the original", () => {
    const f = frame(), out = new Crop().apply("a", f, hdr, { name: "a", pose, region: strip }, "upright");
    expect([...out.d]).toEqual([0, 320, 0]);
    expect([...out.r]).toEqual([0, 6, 0]);
    expect([...f.d]).toEqual([320, 320, 320]);
  });

  it("uses the sensor's pose", () => {
    const out = new Crop().apply("a", frame(), hdr, { name: "a", pose: { ...pose, y: 1.5 }, region: strip }, "upright");   // the beams land at y -0.5, 1.5, 3.5
    expect([...out.d]).toEqual([320, 0, 0]);
  });

  it("passes the frame on as it is without a region or a pose", () => {
    const f = frame(), c = new Crop();
    expect(c.apply("a", f, hdr, { name: "a", pose }, "upright")).toBe(f);
    expect(c.apply("a", f, hdr, { name: "a", region: strip }, "upright")).toBe(f);
    expect(c.apply("a", f, hdr, undefined, "upright")).toBe(f);
  });
});

describe("the region in the rig", () => {
  const region: [number, number][] = [[0, 0], [1, 0], [0, 1]];

  it("is stored, checked and cleared with null", () => {
    const rig = mergeRig({ sensors: [{ name: "a" }] }, { sensors: [{ name: "a", region }] });
    expect(rig.sensors[0].region).toEqual(region);
    expect(() => mergeRig(rig, { sensors: [{ name: "a", region: [[0, 0], [1, 1]] }] })).toThrow(/region/);
    expect(mergeRig(rig, { sensors: [{ name: "a", region: null }] }).sensors[0].region).toBeUndefined();
  });
});

describe("a sensor's own floor in the rig", () => {
  it("is stored, checked and cleared with null", () => {
    const floor = { pitch: 0.4, roll: -0.2, height: 1.1 };
    const rig = mergeRig({ sensors: [{ name: "a" }] }, { sensors: [{ name: "a", floor }] });
    expect(rig.sensors[0].floor).toEqual(floor);
    expect(() => mergeRig(rig, { sensors: [{ name: "a", floor: { pitch: 1 } }] })).toThrow(/floor/);
    expect(() => mergeRig(rig, { sensors: [{ name: "a", floor: { pitch: "x", roll: 0, height: 1 } }] })).toThrow(/floor/);
    expect(mergeRig(rig, { sensors: [{ name: "a", floor: null }] }).sensors[0].floor).toBeUndefined();
  });
});
