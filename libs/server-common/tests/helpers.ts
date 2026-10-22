// Test helpers: polling for a condition, and the simulated rig's scans as frames.
import { elevations } from "@mrs6000/processing/sim/scene";
import { castScan, ROOM, scanTime, simGeometry, type SimSensor } from "@mrs6000/processing/sim/rig";
import type { Header } from "@mrs6000/wire/frame";
import type { SensorFrame } from "../src/sensor/core";

export async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutS = 5): Promise<void> {
  const end = performance.now() + timeoutS * 1000;
  while (!(await cond())) {
    if (performance.now() > end) throw new Error("timed out waiting");
    await new Promise(r => setTimeout(r, 5));
  }
}

/** sensor s's scans k = 0..n-1 of the simulated walk, as a server's frames */
export function simFrames(s: SimSensor, n: number): SensorFrame[] {
  const { L, B, az0, step } = simGeometry(s), el = elevations(L);
  const hdr: Header = { layers: L, beams: B, start_azimuth_deg: az0, step_deg: step, elev: Array.from({ length: L * B }, (_, i) => el[Math.floor(i / B)]), sensor: s.name };
  return Array.from({ length: n }, (_, k) => {
    const t = scanTime(s, k), r = castScan(s, ROOM, t, k), d = new Uint16Array(r.length);
    for (let i = 0; i < r.length; i++) d[i] = Math.min(65535, Math.round(r[i] / 0.0125));
    return { t, d, r: new Uint16Array(r.length).fill(100), hdr, rate: 10, seq: k };
  });
}
