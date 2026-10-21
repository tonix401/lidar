// Wire format of GET /api/frame: an organized range image of the first echo.
//
// Body: three little-endian float32 blocks, each layers × beams, layer-major:
// [distance_m (0 = invalid)] [rssi] [elevation_deg]. Azimuth of beam b = start_azimuth_deg + b * step_deg.
// Meta (JSON in the X-Meta header): see scanMeta().
import { beamCount, elevations, type Scan } from "./model";
import { DIST_UNIT_MM, type Frame, type Header } from "./recording/format";

export function encode(scan: Scan): Uint8Array {
  const L = scan.layers.length, B = beamCount(scan.layers[0]), N = L * B, out = new Float32Array(3 * N);
  scan.layers.forEach((layer, l) => {
    const e = layer.echoes[0], el = elevations(layer);
    for (let b = 0; b < B; b++) {
      out[l * B + b] = e.distanceMm[b] / 1000;
      out[N + l * B + b] = e.rssi[b];
      out[2 * N + l * B + b] = el[b];
    }
  });
  return new Uint8Array(out.buffer);
}

/** a recorded frame (uint16 distances, rssi) in the wire format; the same values as a replay of it */
export function encodeFrame(f: Frame, hdr: Header, elev: Float32Array = Float32Array.from(hdr.elev)): { data: Uint8Array; points: number } {
  const n = f.d.length, out = new Float32Array(3 * n);
  let points = 0;
  for (let i = 0; i < n; i++) { out[i] = f.d[i] * (DIST_UNIT_MM / 1000); if (f.d[i]) points++; }
  out.set(f.r, n);
  out.set(elev, 2 * n);
  return { data: new Uint8Array(out.buffer), points };
}

export interface FrameMetaOut {
  points: number; layers: number; beams: number; start_azimuth_deg: number; step_deg: number;
  rate: number; scan_frequency_hz: number; ts: number; [k: string]: unknown;
}

/** `ts` = acquisition time (unix s; the recorded time for replays), used for velocities */
export function scanMeta(points: number, layers: number, beams: number, az0: number, step: number, rate: number, ts: number): FrameMetaOut {
  return { points, layers, beams, start_azimuth_deg: az0, step_deg: step, rate, scan_frequency_hz: 10.0, ts };
}

export function metaForScan(scan: Scan, rate: number, ts: number): FrameMetaOut {
  const L = scan.layers;
  let points = 0;
  for (const l of L) for (const d of l.echoes[0].distanceMm) if (d > 0) points++;
  return scanMeta(points, L.length, beamCount(L[0]), L[0].startAzimuthDeg, L[0].stepDeg, rate, ts);
}
