// A sensor's own clock mapped onto the host clock, so that scans of several sensors share one timeline.
//
// Every CoLa telegram carries the device time (µs since power-on, uint32: wraps every ~71.6 min). For each
// telegram, host receive time − device time = clock offset + network delay, and the delay is never negative.
// So the lower envelope of those differences is the offset, and its slope the drift (crystals differ by tens of
// ppm, ms per minute): per 1 s bucket the smallest difference, then the lower convex hull of those minima, and
// of its edges the one above the minima's mean time (the line under every point with the least total gap, as in
// Moon et al. 1999, "Estimation and removal of clock skew from network delay measurements"). Late telegrams
// (jitter, a stalled connection) only add points above the hull, so they never move it.
// Scan time = device time + offset (docs/multisensor.md).
import type { Scan } from "./model";

export const WRAP_US = 2 ** 32;

export interface ClockState { offset_s: number; drift_ppm: number; samples: number; resets: number }

export class DeviceClock {
  private buckets: [number, number, number][] = [];   // bucket start, device s and value of its smallest host − device
  lastRaw: number | null = null;
  wraps = 0;
  private a = 0; private b = 0;                          // offset(d) = a + b · (d − dRef)
  private dRef = 0;
  samples = 0;
  resets = 0;

  constructor(private windowS = 300, private bucketS = 1, private stallS = 30) {}

  /** device time in seconds, continuous across the uint32 wrap */
  unwrap(rawUs: number): number {
    if (this.lastRaw !== null && rawUs < this.lastRaw - WRAP_US / 2) this.wraps++;
    this.lastRaw = rawUs;
    return (rawUs + this.wraps * WRAP_US) / 1e6;
  }

  /** one (device time, host receive time) pair */
  add(rawUs: number, hostS: number): void {
    const back = this.lastRaw !== null && this.lastRaw - WRAP_US / 2 <= rawUs && rawUs < this.lastRaw - 1_000_000;
    let d = this.unwrap(rawUs), diff = hostS - d;
    const dev = this.samples ? diff - this.offset(d) : 0;
    // start over after a power cycle (device time jumps back), or when the pair can't be a delay: far below the
    // envelope (host clock stepped back) or far above it (no stall lasts that long)
    if (back || dev < -0.5 || dev > this.stallS) {
      const resets = this.resets + 1;
      Object.assign(this, new DeviceClock(this.windowS, this.bucketS, this.stallS));
      this.resets = resets;
      d = this.unwrap(rawUs); diff = hostS - d;
    }
    this.samples++;
    const last = this.buckets[this.buckets.length - 1];
    if (last && d - last[0] < this.bucketS) {
      if (diff >= last[2]) return;                       // above the envelope: changes nothing
      last[1] = d; last[2] = diff;
    } else this.buckets.push([d, d, diff]);
    while (d - this.buckets[0][0] > this.windowS) this.buckets.shift();
    this.fit();
  }

  private fit(): void {
    const pts = this.buckets.map(b => [b[1], b[2]] as const);
    const hull: (readonly [number, number])[] = [];       // lower hull (monotone chain; pts are in time order)
    for (const p of pts) {
      while (hull.length >= 2) {
        const h1 = hull[hull.length - 1], h2 = hull[hull.length - 2];
        if ((h1[0] - h2[0]) * (p[1] - h2[1]) - (h1[1] - h2[1]) * (p[0] - h2[0]) <= 0) hull.pop(); else break;
      }
      hull.push(p);
    }
    this.dRef = pts[pts.length - 1][0];
    if (hull.length === 1) { this.a = hull[0][1]; this.b = 0; return; }
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    let i = hull.findIndex((_, k) => k < hull.length - 1 && hull[k + 1][0] >= mx);
    if (i < 0) i = hull.length - 2;
    const [x0, y0] = hull[i], [x1, y1] = hull[i + 1];
    this.b = (y1 - y0) / (x1 - x0);
    this.a = y0 + this.b * (this.dRef - x0);
  }

  offset(d: number): number { return this.a + this.b * (d - this.dRef); }

  /** host time of a device time (call after add() for the same or an earlier telegram) */
  toHost(rawUs: number): number {
    let w = this.wraps;
    if (this.lastRaw !== null && rawUs < this.lastRaw - WRAP_US / 2) w++;             // already past the next wrap
    else if (this.lastRaw !== null && rawUs > this.lastRaw + WRAP_US / 2) w--;        // still before the last wrap
    const d = (rawUs + w * WRAP_US) / 1e6;
    return d + this.offset(d);
  }

  state(): ClockState {
    return { offset_s: Math.round(this.a * 1e6) / 1e6, drift_ppm: Math.round(this.b * 1e8) / 100, samples: this.samples, resets: this.resets };
  }
}

/** Feed the scan's telegrams to `clock` and return the host time of its first layer; `fallback` (the host receive
 *  time) for scans without device times (other sources, tests). */
export function scanTime(clock: DeviceClock, scan: Scan, fallback: number): number {
  const timed = scan.layers.filter(l => l.timestampUs !== null && l.receivedS !== null);
  if (!timed.length) return fallback;
  for (const l of timed) clock.add(l.timestampUs!, l.receivedS!);
  const first = scan.layers[0].timestampUs;
  return first !== null ? clock.toHost(first) : fallback;
}
