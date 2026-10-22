// A sensor's processing on a server (src/sensor/): the same results in a worker and on the main thread, objects
// found in a simulated walk.
import { defaultConfig } from "@mrs6000/processing/config/config";
import { RIG3 } from "@mrs6000/processing/sim/rig";
import { afterEach, describe, expect, it } from "vitest";
import type { SensorFrame, SensorOutput } from "../src/sensor/core";
import { SensorRunner } from "../src/sensor/runner";
import { simFrames, waitUntil } from "./helpers";

const runners: SensorRunner[] = [];
afterEach(() => { for (const r of runners.splice(0)) r.close(); });

async function run(frames: SensorFrame[], threaded: boolean): Promise<SensorOutput[]> {
  const outs: SensorOutput[] = [], cfg = defaultConfig();
  cfg.objects.learn = 2;
  const r = new SensorRunner("a", 0, cfg, "auto", { output: o => outs.push(o) }, { threaded });
  runners.push(r);
  for (const f of frames) {                          // one at a time: no frame dropped
    const n = outs.length;
    r.push({ ...f, d: f.d.slice(), r: f.r.slice() });
    await waitUntil(() => outs.length > n);
  }
  return outs;
}

describe("sensor processing on a server", () => {
  const frames = simFrames({ ...RIG3[0], noise: 0.01, seed: 1 }, 60);

  it("finds the walker; a worker gives exactly what the main thread gives", async () => {
    const here = await run(frames, false), there = await run(frames, true);
    expect(here.length).toBe(60);
    expect(here[59].bgReady).toBe(true);
    const tracked = here.filter(o => o.tracks.some(t => t.moved && t.det));
    expect(tracked.length).toBeGreaterThan(10);                                   // the walk starts at 3 s
    expect(here.at(-1)!.observations.length).toBe(1);
    expect(there.map(o => [o.seq, o.tracks, o.observations.length, Array.from(o.raw)]))
      .toEqual(here.map(o => [o.seq, o.tracks, o.observations.length, Array.from(o.raw)]));
    console.log(`objects-only processing: ${(here.slice(20).reduce((s, o) => s + o.stats.ingestMs, 0) / 40).toFixed(2)} ms per scan (24 × ${frames[0].hdr.beams})`);
  });

  it("a worker that falls behind keeps only the newest waiting frame", async () => {
    const outs: SensorOutput[] = [];
    const r = new SensorRunner("a", 0, defaultConfig(), "auto", { output: o => outs.push(o) }, { threaded: true });
    runners.push(r);
    for (const f of frames.slice(0, 20)) r.push({ ...f, d: f.d.slice(), r: f.r.slice() });   // all at once
    await waitUntil(() => outs.at(-1)?.seq === 19);
    expect(outs.length + r.dropped).toBe(20);
    expect(r.dropped).toBeGreaterThan(0);
  });
});
