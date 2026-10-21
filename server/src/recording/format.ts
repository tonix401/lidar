// The recording format: temporal point clouds.
//
// x.tpc: one JSON header line {layers, beams, start_azimuth_deg, step_deg, elev[layers*beams], upside_down?, sensor?},
// then fixed-size scans: float64 unix time, uint16 raw distance (units of 12.5 mm, 0 = invalid), uint16 rssi
// — layer-major, little endian. Scan k sits at header_end + k * frame_size. ~88 kB per scan (~53 MB per minute
// at 10 Hz).
//
// x.tpc.zstd (what the recorder writes): a standard zstd stream that decompresses to x.tpc (`zstd -d`). Its zstd
// frames hold the header line, then chunks of up to CHUNK_FRAMES scans. Each is preceded by an index entry in a
// skippable frame (which zstd ignores): "TPC1", uint32 scans m, uint32 length of the zstd frame that follows, the
// m float64 scan times (m = 0 for the header). Chunks are written whole, so readers index complete chunks only.
// ~13 kB per scan (~7.5 MB per minute, indoor scene). The same format the Python backend wrote.
import { beamCount, elevations, type Scan } from "../model";

export const DIST_UNIT_MM = 12.5;
export const CHUNK_FRAMES = 25;          // 2.5 s at 10 Hz: what a crash can lose, how far a file being recorded lags
export const LEVEL = 19;                 // ~14 ms per scan on a desktop core, off the main thread
export const FAST_LEVEL = 3;             // used while the writer falls behind (slow machine)
export const SKIP_MAGIC = 0x184d2a5e;    // zstd skippable frame
export const ZSTD_MAGIC = 0xfd2fb528;    // zstd data frame
export const INDEX_SIZE = 20;            // skippable magic, content size, "TPC1", scans, zstd frame length
export const INDEX_TAG = "TPC1";

/** one scan as recorded: time, raw distances (12.5 mm units), rssi */
export interface Frame { t: number; d: Uint16Array; r: Uint16Array }

export interface Header {
  layers: number; beams: number; start_azimuth_deg: number; step_deg: number; elev: number[];
  upside_down?: boolean; sensor?: string; [k: string]: unknown;
}

export function headerOf(scan: Scan, upsideDown: boolean | null = null, sensor: string | null = null): Header {
  const L = scan.layers;
  const hdr: Header = { layers: L.length, beams: beamCount(L[0]), start_azimuth_deg: L[0].startAzimuthDeg, step_deg: L[0].stepDeg,
                        elev: L.flatMap(l => Array.from(elevations(l))) };
  if (upsideDown !== null) hdr.upside_down = upsideDown;
  if (sensor !== null) hdr.sensor = sensor;
  return hdr;
}

export const headerLine = (hdr: Header): Uint8Array => new TextEncoder().encode(JSON.stringify(hdr) + "\n");

export const streamHeader = (scan: Scan, upsideDown: boolean | null = null, sensor: string | null = null): Uint8Array =>
  headerLine(headerOf(scan, upsideDown, sensor));

/** Python's round(): halves to even */
function roundHalfEven(x: number): number {
  const f = Math.floor(x), r = x - f;
  return r > 0.5 || (r === 0.5 && f % 2 !== 0) ? f + 1 : f;
}

/** a scan's first echo as uint16 distances (12.5 mm units) and rssi */
export function frameValues(scan: Scan): { d: Uint16Array; r: Uint16Array } {
  const B = beamCount(scan.layers[0]), n = scan.layers.length * B, d = new Uint16Array(n), r = new Uint16Array(n);
  let i = 0;
  for (const l of scan.layers) {
    const e = l.echoes[0];
    if (e.distanceMm.length !== B) throw new Error("layers of different length");
    for (let b = 0; b < B; b++, i++) {
      d[i] = Math.min(65535, roundHalfEven(e.distanceMm[b] / DIST_UNIT_MM));
      r[i] = Math.min(65535, Math.max(0, Math.trunc(e.rssi[b])));
    }
  }
  return { d, r };
}

/** one .tpc scan */
export function frameBytes(f: Frame): Uint8Array {
  const n = f.d.length, out = new Uint8Array(8 + 4 * n);
  new DataView(out.buffer).setFloat64(0, f.t, true);
  out.set(new Uint8Array(f.d.buffer, f.d.byteOffset, 2 * n), 8);
  out.set(new Uint8Array(f.r.buffer, f.r.byteOffset, 2 * n), 8 + 2 * n);
  return out;
}

export const streamFrame = (scan: Scan, t: number): Uint8Array => frameBytes({ t, ...frameValues(scan) });

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** the index entry in front of a zstd frame of `zlen` bytes holding `times.length` scans */
function indexEntry(times: readonly number[], zlen: number): Uint8Array {
  const out = new Uint8Array(INDEX_SIZE + 8 * times.length), v = new DataView(out.buffer);
  v.setUint32(0, SKIP_MAGIC, true); v.setUint32(4, 12 + 8 * times.length, true);
  out.set(new TextEncoder().encode(INDEX_TAG), 8);
  v.setUint32(12, times.length, true); v.setUint32(16, zlen, true);
  times.forEach((t, k) => v.setFloat64(INDEX_SIZE + 8 * k, t, true));
  return out;
}

/** `data` as one zstd frame, preceded by its index entry */
export function zstdEntry(data: Uint8Array, times: readonly number[] = [], level = LEVEL): Uint8Array {
  const z = Bun.zstdCompressSync(data, { level });
  return concat([indexEntry(times, z.length), z]);
}

/** the same, compressed off the main thread */
export async function zstdEntryAsync(data: Uint8Array, times: readonly number[] = [], level = LEVEL): Promise<Uint8Array> {
  const z = await Bun.zstdCompress(data, { level });
  return concat([indexEntry(times, z.length), z]);
}

export const chunkData = (frames: readonly Frame[]): Uint8Array => concat(frames.map(frameBytes));

/** one .tpc.zstd chunk */
export const streamChunk = (frames: readonly Frame[], level = LEVEL): Uint8Array => zstdEntry(chunkData(frames), frames.map(f => f.t), level);
