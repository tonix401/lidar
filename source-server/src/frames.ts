// A CoLa scan in the debug page's frame format (libs/server-common/src/frames.ts): what the reader's encoded() must
// equal without building a Scan, and what the Python backend's files were checked against.
import { scanMeta, type FrameMetaOut } from "@mrs6000/server-common/frames";
import { beamCount, elevations, type Scan } from "./model";

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

export function metaForScan(scan: Scan, rate: number, ts: number): FrameMetaOut {
  const L = scan.layers;
  let points = 0;
  for (const l of L) for (const d of l.echoes[0].distanceMm) if (d > 0) points++;
  return scanMeta(points, L.length, beamCount(L[0]), L[0].startAzimuthDeg, L[0].stepDeg, rate, ts);
}
