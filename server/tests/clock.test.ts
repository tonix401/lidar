import { describe, expect, it } from "vitest";
import { DeviceClock, scanTime, WRAP_US } from "../src/clock";
import { makeScan } from "./helpers";

/** a seeded uniform generator (mulberry32) and an exponential variate from it */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { random: next, expo: (mean: number) => -Math.log(1 - next()) * mean };
}

/** (raw device µs, host receive time, true time): 24 layer telegrams per 0.1 s scan, network delay 0.5 ms +
 *  exponential jitter (mean 3 ms) and occasional 50 ms spikes; `stall` = [start, end) of a period where everything
 *  arrives late (TCP retransmits) up to its end */
function telegrams(seconds: number, o: { startRaw?: number; driftPpm?: number; t0?: number; seed?: number; stall?: [number, number] } = {}) {
  const { startRaw = 5_000_000, driftPpm = 40, t0 = 2_000_000_000, seed = 1, stall } = o, r = rng(seed), out: [number, number, number][] = [];
  for (let k = 0; k < seconds * 240; k++) {
    const t = t0 + k / 240, dev = startRaw + (t - t0) * (1 + driftPpm * 1e-6) * 1e6;
    const delay = 0.0005 + r.expo(0.003) + (r.random() < 0.01 ? 0.05 : 0);
    let h = t + delay;
    if (stall && stall[0] <= t - t0 && t - t0 < stall[1]) h = t0 + stall[1] + delay;
    out.push([Math.floor(dev) % WRAP_US, h, t]);
  }
  return out;
}

function worstError(clock: DeviceClock, tel: [number, number, number][], skipS = 5) {
  let worst = 0;
  const t0 = tel[0][2];
  for (const [raw, h, t] of tel) {
    clock.add(raw, h);
    if (t - t0 > skipS) worst = Math.max(worst, Math.abs(clock.toHost(raw) - t));
  }
  return worst;
}

describe("device clock", () => {
  it("maps device time to host time within a millisecond", () => {
    const c = new DeviceClock();
    // the mapped time is the true time plus the smallest network delay (0.5 ms), whatever the jitter
    expect(worstError(c, telegrams(120))).toBeLessThan(0.0007);
    expect(c.state().drift_ppm).toBeGreaterThan(-45);
    expect(c.state().drift_ppm).toBeLessThan(-35);
    expect(c.resets).toBe(0);
  });

  it("stays continuous across the uint32 wrap", () => {
    const tel = telegrams(30, { startRaw: WRAP_US - 10_000_000 });                  // wraps after 10 s
    expect(tel.some((b, i) => i > 0 && b[0] < tel[i - 1][0])).toBe(true);
    const c = new DeviceClock();
    expect(worstError(c, tel)).toBeLessThan(0.0007);
    expect(c.wraps).toBe(1);
    expect(c.resets).toBe(0);
  });

  it("starts over after a power cycle", () => {
    const a = telegrams(30, { startRaw: 900_000_000 });
    const b = telegrams(30, { startRaw: 2_000_000, t0: a[a.length - 1][2] + 20, seed: 2 });   // rebooted: device time back near 0
    const c = new DeviceClock();
    worstError(c, a);
    expect(worstError(c, b)).toBeLessThan(0.0007);
    expect(c.resets).toBe(1);
  });

  it("does not move the offset during a network stall", () => {
    const c = new DeviceClock();
    expect(worstError(c, telegrams(60, { stall: [20, 25] }))).toBeLessThan(0.0007);
    expect(c.resets).toBe(0);
  });

  it("scan time uses the first layer or falls back", () => {
    const c = new DeviceClock(), scan = makeScan();
    expect(scanTime(c, scan, 123)).toBe(123);                                       // no device times (other sources)
    scan.layers.forEach((l, i) => { l.timestampUs = 10_000_000 + 4000 * i; l.receivedS = 500 + 0.004 * i + 0.001; });
    expect(scanTime(c, scan, 0)).toBeCloseTo(500.001, 6);
  });
});
