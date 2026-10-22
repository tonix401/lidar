// The debug page's frame format (GET /api/frame of the debug processing server): an organized range image of the
// first echo.
//
// Body: three little-endian float32 blocks, each layers × beams, layer-major:
// [distance_m (0 = invalid)] [rssi] [elevation_deg]. Azimuth of beam b = start_azimuth_deg + b * step_deg.
// Meta (JSON in the X-Meta header): see scanMeta().
import { DIST_UNIT_MM, type Frame, type Header } from "@mrs6000/wire/frame";

/** a recorded frame (uint16 distances, rssi) in the page's format */
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
