// The page's model of the server's messages: subscribing resets it, objects of other sources are ignored, a closed
// replay falls back to live, and the message rate is counted over two seconds.
import { describe, expect, it } from "vitest";
import { ObjectsModel } from "../src/model";

const obj = { id: 1, cls: "person", x: 1, y: 2, vx: 0, vy: 0, speed: 0, box: { len: 0.5, wid: 0.4, yaw: 0, z0: 0, z1: 1.7 }, sensors: ["a"], age: 1, moved: false };

describe("objects model", () => {
  it("follows the subscription, the objects and the replay's end", () => {
    const m = new ObjectsModel();
    expect(m.apply({ type: "subscribed", source: "r1", sensors: ["a", "b"], rig: { sensors: [{ name: "a" }] }, replay: { playing: true }, owner: true })).toBe(true);
    expect([m.source, m.sensors, m.owner]).toEqual(["r1", ["a", "b"], true]);
    expect(m.apply({ type: "objects", source: "live", t: 1, objects: [obj] })).toBe(false);   // not what it watches
    expect(m.apply({ type: "objects", source: "r1", t: 2, objects: [obj] }, 0)).toBe(true);
    m.apply({ type: "track", source: "r1", event: "start", id: 1 });
    expect([m.objects.length, m.t, m.started]).toEqual([1, 2, 1]);
    m.apply({ type: "state", source: "r1", replay: { playing: false }, error: "" });
    expect(m.replay).toEqual({ playing: false });
    m.apply({ type: "closed", source: "r1", reason: "nobody watching" });
    expect([m.source, m.objects, m.error]).toEqual(["live", [], "replay ended (nobody watching)"]);
  });

  it("counts messages per second", () => {
    const m = new ObjectsModel();
    m.apply({ type: "subscribed", source: "live", sensors: [], rig: { sensors: [] } });
    for (let k = 0; k <= 10; k++) m.apply({ type: "objects", source: "live", t: k, objects: [] }, 1000 + k * 100);
    expect(m.rate(2000)).toBeCloseTo(10, 6);
    expect(m.rate(5000)).toBe(0);
  });
});
