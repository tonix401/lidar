// Writing recordings: a .tpc file (format: backend/src/mrs6000/recording/format.py) and a multi-sensor
// session folder of them (backend/src/mrs6000/recording/session.py) from the simulated rig. Used by the
// end-to-end tests and by scripts/simulate-session.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toParams } from "../../src/fusion/pose";
import { castScan, scanTime, simGeometry, type Room, type SimSensor } from "./rig";
import { elevations } from "./scene";

export interface TpcHeader { layers: number; beams: number; start_azimuth_deg: number; step_deg: number; elev: number[]; upside_down?: boolean; sensor?: string }

/** a .tpc file: the header line, then per scan its time and ranges (m; 0 = no return), RSSI 100 */
export function writeTpc(path: string, hdr: TpcHeader, scans: Iterable<[number, Float32Array]>): void {
  const N = hdr.layers * hdr.beams, parts: Buffer[] = [Buffer.from(JSON.stringify(hdr) + "\n")];
  for (const [t, d] of scans) {
    const buf = Buffer.alloc(8 + 4 * N);
    buf.writeDoubleLE(t, 0);
    for (let i = 0; i < N; i++) { buf.writeUInt16LE(Math.min(65535, Math.round(d[i] / 0.0125)), 8 + 2 * i); buf.writeUInt16LE(100, 8 + 2 * N + 2 * i); }
    parts.push(buf);
  }
  writeFileSync(path, Buffer.concat(parts));
}

export const simHeader = (s: SimSensor): TpcHeader => {
  const { L, B, az0, step } = simGeometry(s);
  return { layers: L, beams: B, start_azimuth_deg: az0, step_deg: step, upside_down: false, sensor: s.name,
           elev: elevations(L).flatMap(e => Array<number>(B).fill(e)) };
};

/** a session folder `dir`: one .tpc per sensor over `seconds`, on one clock starting at `t0`. Its rig has no
 *  poses (that is what calibration finds); the true ones are under "truth" (ignored by the backend). */
export function writeSession(dir: string, rig: SimSensor[], room: Room, seconds: number, t0 = 1.7e9): void {
  mkdirSync(dir, { recursive: true });
  for (const s of rig) {
    const scans = function* () { for (let k = 0; k < seconds * 10; k++) { const t = scanTime(s, k); yield [t0 + t, castScan(s, room, t, k)] as [number, Float32Array]; } };
    writeTpc(join(dir, `${s.name}.tpc`), simHeader(s), scans());
  }
  writeFileSync(join(dir, "session.json"), JSON.stringify({
    sensors: rig.map(s => ({ name: s.name, file: `${s.name}.tpc` })), rig: { sensors: rig.map(s => ({ name: s.name })) },
    created: t0, complete: true, truth: rig.map(s => ({ name: s.name, pose: toParams(s.pose) })),
  }, null, 2) + "\n");
}
