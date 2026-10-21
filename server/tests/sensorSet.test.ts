// Several sensors processed together on the server (src/sensorSet.ts): the simulated three-sensor rig through
// workers, calibrated (true poses), gives one fused world track following the walker.
import { defaultConfig } from "@mrs6000/processing/config/config";
import { toParams } from "@mrs6000/processing/fusion/pose";
import { castScan, RIG3, ROOM, scanTime, simGeometry, type SimSensor } from "@mrs6000/processing/sim/rig";
import { elevations } from "@mrs6000/processing/sim/scene";
import { afterEach, describe, expect, it } from "vitest";
import type { Header } from "../src/recording/format";
import type { SensorFrame } from "../src/sensor/core";
import { SensorSet, type ObjectsTick } from "../src/sensorSet";
import { waitUntil } from "./helpers";

function frames(s: SimSensor, n: number): SensorFrame[] {
  const { L, B, az0, step } = simGeometry(s), el = elevations(L);
  const hdr: Header = { layers: L, beams: B, start_azimuth_deg: az0, step_deg: step, elev: Array.from({ length: L * B }, (_, i) => el[Math.floor(i / B)]), sensor: s.name };
  return Array.from({ length: n }, (_, k) => {
    const t = scanTime(s, k), r = castScan(s, ROOM, t, k), d = new Uint16Array(r.length);
    for (let i = 0; i < r.length; i++) d[i] = Math.min(65535, Math.round(r[i] / 0.0125));
    return { t, d, r: new Uint16Array(r.length).fill(100), hdr, rate: 10, seq: k };
  });
}

const sets: SensorSet[] = [];
afterEach(() => { for (const s of sets.splice(0)) s.close(); });

describe("sensors processed together", () => {
  it("one world track per person, on the walker", { timeout: 60_000 }, async () => {
    const rig = RIG3.map((s, k) => ({ ...s, noise: 0.01, seed: k + 1 })), cfg = defaultConfig();
    cfg.objects.learn = 2;
    const ticks: ObjectsTick[] = [];
    let outputs = 0;
    const set = new SensorSet(rig.map(s => ({ name: s.name, input: { kind: "frames" as const } })), cfg,
                              { output: () => outputs++, objects: t => ticks.push(t) }, { threaded: true });
    sets.push(set);
    set.setRig({ sensors: rig.map(s => ({ name: s.name, pose: toParams(s.pose), calibrated: "test" })) });
    const all = rig.flatMap((s, k) => frames(s, 80).map(f => ({ k, f }))).sort((a, b) => a.f.t - b.f.t);
    for (const { k, f } of all) {                      // in time order, each processed before the next (deterministic)
      const n = outputs;
      set.push(k, f);
      await waitUntil(() => outputs > n);
    }
    const walking = ticks.filter(t => t.t > 4.5);
    const one = walking.filter(t => t.objects.length === 1);
    expect(one.length / walking.length).toBeGreaterThan(0.9);
    const err = one.map(t => {
      const p = ROOM.people(t.t)[0], o = t.objects[0];
      return Math.hypot(o.x - p.x, o.y - p.y);
    }).sort((a, b) => a - b);
    console.log(`one track in ${(100 * one.length / walking.length).toFixed(0)} % of the sets; ${(err[err.length >> 1] * 100).toFixed(1)} cm median from the walker's axis; sensors per object ${(one.reduce((s, t) => s + t.objects[0].sensors.length, 0) / one.length).toFixed(1)}`);
    expect(err[err.length >> 1]).toBeLessThan(0.1);
    expect(one.some(t => t.objects[0].sensors.length >= 2)).toBe(true);
    expect(one.at(-1)!.objects[0]).toMatchObject({ cls: "person", moved: true, sensors: ["a", "b", "c"] });
  });
});
