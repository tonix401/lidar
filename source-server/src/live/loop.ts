// A live sensor's loop: its CoLa connection, each scan as a frame on the host clock (clock.ts), the same header
// while the layout stays. Runs in the sensor's own worker (worker.ts), or on the main thread (tests' scan generators).
import { Health, type Stop } from "@mrs6000/server-common/health";
import { nowS } from "@mrs6000/server-common/log";
import type { SensorFrame } from "@mrs6000/server-common/sensor/core";
import type { ClockState } from "@mrs6000/wire/source";
import { DeviceClock, scanTime } from "../clock";
import type { Scan } from "../model";
import { frameValues, headerOf, type Header } from "../recording/format";

/** a sensor's live connection state */
export interface LoopStatus { error: string; rate: number; clock: ClockState }

/** does `hdr` still describe this scan (layer count, beams, azimuths, every elevation, mount)? */
function sameLayout(hdr: Header | null, scan: Scan, upsideDown: boolean | null): boolean {
  if (!hdr || hdr.layers !== scan.layers.length || (hdr.upside_down ?? null) !== upsideDown) return false;
  const B = hdr.beams, l0 = scan.layers[0];
  if (l0.echoes[0].distanceMm.length !== B || l0.startAzimuthDeg !== hdr.start_azimuth_deg || l0.stepDeg !== hdr.step_deg) return false;
  for (let l = 0; l < scan.layers.length; l++) {
    const layer = scan.layers[l], e = layer.beamElevationDeg;
    for (let b = 0; b < B; b++) if ((e ? e[b] : layer.elevationDeg) !== hdr.elev[l * B + b]) return false;
  }
  return true;
}

/** A live sensor's loop: connect, stream, and on any failure (sensor off, unplugged, timeout, bad telegram) report
 *  one short line and reconnect every retryS seconds. Each scan becomes a SensorFrame on the shared clock. */
export async function liveLoop(name: string, source: () => AsyncIterable<Scan>, stop: Stop, retryS: number,
                               upsideDown: () => boolean | null, emit: (f: SensorFrame) => void,
                               status: (s: LoopStatus) => void, label = name): Promise<void> {
  const clock = new DeviceClock(), health = new Health(`${label} (CoLa)`, retryS);
  let seq = 0, rate = 0, error = "", hdr: Header | null = null;
  const report = () => status({ error, rate, clock: clock.state() });
  while (!stop.isSet) {
    try {
      let last = nowS();
      for await (const scan of source()) {
        if (stop.isSet) return;
        const now = nowS();
        if (health.error) { health.ok(); error = ""; }
        const t = scanTime(clock, scan, now), { d, r } = frameValues(scan);
        rate = 1 / Math.max(now - last, 1e-3);
        last = now;
        hdr = sameLayout(hdr, scan, upsideDown()) ? hdr : headerOf(scan, upsideDown(), name);   // one header while the layout stays
        emit({ t, d, r, hdr: hdr!, rate, seq: seq++ });
        if (seq % 10 === 1) report();
      }
      error = `${label}: ` + health.fail("stream ended");
    } catch (e) {
      error = `${label}: ` + health.fail(e);
    }
    rate = 0;
    report();
    await stop.wait(retryS);
  }
}
