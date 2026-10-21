// A sensor's processing on the server (src/sensor/): the same results in a worker and on the main thread, objects
// found in a simulated walk, a live CoLa stream through a worker.
import { defaultConfig } from "@mrs6000/processing/config/config";
import { elevations } from "@mrs6000/processing/sim/scene";
import { castScan, RIG3, ROOM, scanTime, simGeometry, type SimSensor } from "@mrs6000/processing/sim/rig";
import { afterEach, describe, expect, it } from "vitest";
import type { Header } from "../src/recording/format";
import type { SensorFrame, SensorOutput, SensorStatus } from "../src/sensor/core";
import { SensorRunner } from "../src/sensor/runner";
import { FakeCola, realTelegrams, waitUntil } from "./helpers";

/** sensor s's scans k = 0..n-1 of the simulated walk, as the server's frames */
function simFrames(s: SimSensor, n: number): SensorFrame[] {
  const { L, B, az0, step } = simGeometry(s), el = elevations(L);
  const hdr: Header = { layers: L, beams: B, start_azimuth_deg: az0, step_deg: step, elev: Array.from({ length: L * B }, (_, i) => el[Math.floor(i / B)]), sensor: s.name };
  return Array.from({ length: n }, (_, k) => {
    const t = scanTime(s, k), r = castScan(s, ROOM, t, k), d = new Uint16Array(r.length);
    for (let i = 0; i < r.length; i++) d[i] = Math.min(65535, Math.round(r[i] / 0.0125));
    return { t, d, r: new Uint16Array(r.length).fill(100), hdr, rate: 10, seq: k };
  });
}

const runners: SensorRunner[] = [];
afterEach(() => { for (const r of runners.splice(0)) r.close(); });

async function run(frames: SensorFrame[], threaded: boolean): Promise<SensorOutput[]> {
  const outs: SensorOutput[] = [], cfg = defaultConfig();
  cfg.objects.learn = 2;
  const r = new SensorRunner("a", 0, cfg, "auto", { kind: "frames" }, { output: o => outs.push(o) }, { threaded });
  runners.push(r);
  for (const f of frames) {                          // one at a time: no frame dropped
    const n = outs.length;
    r.push({ ...f, d: f.d.slice(), r: f.r.slice() });
    await waitUntil(() => outs.length > n);
  }
  return outs;
}

describe("sensor processing on the server", () => {
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
    const r = new SensorRunner("a", 0, defaultConfig(), "auto", { kind: "frames" }, { output: o => outs.push(o) }, { threaded: true });
    runners.push(r);
    for (const f of frames.slice(0, 20)) r.push({ ...f, d: f.d.slice(), r: f.r.slice() });   // all at once
    await waitUntil(() => outs.at(-1)?.seq === 19);
    expect(outs.length + r.dropped).toBe(20);
    expect(r.dropped).toBeGreaterThan(0);
  });

  it("streams a live CoLa sensor through a worker", async () => {
    const sensor = await FakeCola.start(realTelegrams());
    try {
      const got: SensorFrame[] = [], outs: SensorOutput[] = [], status: SensorStatus[] = [];
      const r = new SensorRunner("a", 0, defaultConfig(), "auto", { kind: "cola", ip: "127.0.0.1", port: sensor.port },
                                 { frame: f => got.push(f), output: o => outs.push(o), status: s => status.push(s) }, { threaded: true });
      runners.push(r);
      await waitUntil(() => got.length >= 12 && outs.length >= 12 && status.length > 0);
      expect(got[0].hdr.layers).toBe(24);
      expect(got[0].hdr.beams).toBe(923);
      expect(got[5].hdr).toEqual(got[0].hdr);                                       // sent once, kept
      expect(got[0].d.length).toBe(24 * 923);
      expect(status.at(-1)!.error).toBe("");
      expect(status.at(-1)!.clock.samples).toBeGreaterThan(0);
    } finally {
      await sensor.close();
    }
  });
});
