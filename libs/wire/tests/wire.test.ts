// The wire formats: the binary frame message survives a round trip whatever the meta's length, and a client's
// options select, move and trim the objects as documented.
import { describe, expect, it } from "vitest";
import { frameMessage, readFrameMessage } from "../src/frame";
import { forClient, inside, type WorldObject } from "../src/objects";
import { rigFor } from "../src/rig";

const obj = (o: Partial<WorldObject> = {}): WorldObject => ({
  id: 1, cls: "person", x: 2, y: 1, vx: 1, vy: 0, speed: 1, box: { len: 0.5, wid: 0.4, yaw: 0, z0: 0, z1: 1.7 },
  sensors: ["a"], age: 1, moved: true, trail: [1, 1, 2, 1], ...o,
});

describe("frame message", () => {
  it("round-trips the meta and both arrays, 4-byte aligned, for any meta length", () => {
    for (const sensor of ["a", "ab", "abc", "abcd"]) {
      const d = Uint16Array.from({ length: 12 }, (_, i) => i * 7), r = Uint16Array.from({ length: 12 }, (_, i) => 1000 - i);
      const msg = frameMessage({ v: 1, type: "frame", sensor, k: 3, t: 1.5 }, d, r);
      expect((4 + new DataView(msg.buffer).getUint32(0, true)) % 4).toBe(0);
      const got = readFrameMessage(msg);
      expect(got.meta).toEqual({ v: 1, type: "frame", sensor, k: 3, t: 1.5 });
      expect(Array.from(got.d)).toEqual(Array.from(d));
      expect(Array.from(got.r)).toEqual(Array.from(r));
    }
  });

  it("reads a message that sits inside a larger buffer", () => {
    const msg = frameMessage({ type: "frame" }, new Uint16Array([1, 2]), new Uint16Array([3, 4]));
    const big = new Uint8Array(msg.length + 8);
    big.set(msg, 8);
    const got = readFrameMessage(big.subarray(8));
    expect([...got.d, ...got.r]).toEqual([1, 2, 3, 4]);
  });
});

describe("client options", () => {
  it("filters by class and region", () => {
    const objs = [obj({ id: 1 }), obj({ id: 2, cls: "object" }), obj({ id: 3, x: 9 })];
    expect(forClient(objs, { classes: ["person"] }).map(o => o.id)).toEqual([1, 3]);
    expect(forClient(objs, { region: [[0, 0], [5, 0], [5, 5], [0, 5]] }).map(o => o.id)).toEqual([1, 2]);
    expect(inside([[0, 0], [1, 0], [0, 1]], 0.2, 0.2)).toBe(true);
    expect(inside([[0, 0], [1, 0], [0, 1]], 0.8, 0.8)).toBe(false);
  });

  it("moves objects into the client's frame and drops trails unless asked for", () => {
    const [o] = forClient([obj()], { transform: { x: 2, y: 0, yaw: 90 }, trails: true });
    expect([o.x, o.y, o.vx, o.vy, o.box.yaw]).toEqual([1, 0, 0, -1, -90]);
    expect(o.trail).toEqual([1, 1, 1, 0]);
    expect(forClient([obj()], {})[0].trail).toBeUndefined();
  });
});

describe("rig", () => {
  it("orders entries by name and fills in missing ones", () => {
    const rig = { sensors: [{ name: "b", calibrated: "x" }, { name: "a" }] };
    expect(rigFor(rig, ["a", "b", "c"]).sensors).toEqual([{ name: "a" }, { name: "b", calibrated: "x" }, { name: "c" }]);
  });
});
