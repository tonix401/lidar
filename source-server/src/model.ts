// Scan data model: one Scan = all layers of one mirror revolution.

export const DIST_INVALID_MAX_RAW = 15;      // raw distances <= 15 are invalid (per SICK web UI)

export interface Echo {
  distanceMm: Float64Array;                  // 0 = invalid
  rssi: Uint16Array;
}

export interface Layer {
  elevationDeg: number;                      // nominal layer angle
  startAzimuthDeg: number;                   // azimuth of the first beam, 0 = straight ahead, +left
  stepDeg: number;
  echoes: Echo[];
  beamElevationDeg: Float64Array | null;     // per-beam elevation (CoLa VANGL channel)
  timestampUs: number | null;                // sensor time since power-on (CoLa only)
  receivedS: number | null;                  // host time the telegram arrived (CoLa only; see clock.ts)
}

export interface Scan {
  layers: Layer[];
  scanFrequencyHz: number | null;
  rawTelegrams: string[];                    // CoLa A source only, one per layer
}

export const newScan = (scanFrequencyHz: number | null = null): Scan => ({ layers: [], scanFrequencyHz, rawTelegrams: [] });

export const beamCount = (l: Layer): number => l.echoes[0]?.distanceMm.length ?? 0;

export const elevations = (l: Layer): ArrayLike<number> => l.beamElevationDeg ?? new Float64Array(beamCount(l)).fill(l.elevationDeg);

/** every valid return as (x, y, z, distance m, rssi, layer, echo): x forward, y left, z up, for a sensor standing
 *  upright (negative elevation = down). Upside down (device parameter UpsideDown set) flips only z: the device
 *  already reports azimuth in world left/right. */
export function* points(scan: Scan, echo: number | null = null, upsideDown = false): Generator<[number, number, number, number, number, number, number]> {
  const s = upsideDown ? -1 : 1, D = Math.PI / 180;
  for (let li = 0; li < scan.layers.length; li++) {
    const layer = scan.layers[li], els = elevations(layer);
    for (let ei = 0; ei < layer.echoes.length; ei++) {
      if (echo !== null && ei !== echo) continue;
      const e = layer.echoes[ei];
      for (let bi = 0; bi < e.distanceMm.length; bi++) {
        const dmm = e.distanceMm[bi];
        if (dmm <= 0) continue;
        const d = dmm / 1000, el = els[bi] * D, az = (layer.startAzimuthDeg + bi * layer.stepDeg) * D;
        yield [Math.cos(az) * Math.cos(el) * d, Math.sin(az) * Math.cos(el) * d, s * Math.sin(el) * d, d, e.rssi[bi], li, ei];
      }
    }
  }
}
