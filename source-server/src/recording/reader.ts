// Reading recordings (format: format.ts): random access to a .tpc or .tpc.zstd file, which may still grow while
// it is being recorded.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { describeError, ValueError } from "@mrs6000/server-common/errors";
import { newScan, type Scan } from "../model";
import { DIST_UNIT_MM, INDEX_SIZE, INDEX_TAG, SKIP_MAGIC, ZSTD_MAGIC, type Frame, type Header } from "./format";

/** what replay publishes for a frame: sensor, time, the /api/frame payload, valid points, its header */
export interface PublishedFrame { sensor: string; t: number; data: Uint8Array; points: number; hdr: Header }

export interface RecordingInfo { name: string; bytes: number; scans: number; seconds: number; created: number; sensors?: string[] }

export class Recording {
  readonly path: string;
  readonly compressed: boolean;
  readonly header: Uint8Array;                       // the header line as stored
  readonly hdr: Header;
  readonly L: number; readonly B: number; readonly n: number;
  readonly frameSize: number;
  private fd: number;
  private times: number[] = [];                      // .tpc.zstd: the index of the complete chunks,
  readonly chunks: [number, number, number, number][] = [];   // (first scan, scans, frame offset, frame length)
  private indexed = 0;                               // file offset after the last indexed entry
  private cache = new Map<number, Uint8Array>();     // decoded chunks (playback reads in order)
  private elev: Float32Array;

  constructor(path: string) {
    this.path = path;
    this.fd = openSync(path, "r");
    try {
      const magic = new DataView(this.read(0, 4).buffer).getUint32(0, true);
      if (magic === ZSTD_MAGIC) throw new ValueError("plain zstd without the scan index: zstd -d it, or use mrs6000 compress");
      this.compressed = magic === SKIP_MAGIC;
      if (this.compressed) {
        const e = this.entry(0, statSync(this.path).size);
        if (!e || e.scans !== 0) throw new ValueError("no header");
        this.header = Bun.zstdDecompressSync(this.read(e.off, e.zlen));
        this.indexed = e.off + e.zlen;
      } else this.header = this.headerLine();
      this.hdr = JSON.parse(new TextDecoder().decode(this.header)) as Header;
      this.L = Number(this.hdr.layers); this.B = Number(this.hdr.beams);
      if (!Number.isInteger(this.L) || !Number.isInteger(this.B) || !Array.isArray(this.hdr.elev)) throw new ValueError("bad header");
      if (this.hdr.elev.length !== this.L * this.B) throw new ValueError("header elevation table has the wrong size");
    } catch (e) {
      closeSync(this.fd);
      throw new ValueError(`not a .tpc recording (${describeError(e)})`);
    }
    this.n = this.L * this.B;
    this.frameSize = 8 + 4 * this.n;
    this.elev = Float32Array.from(this.hdr.elev);
    if (this.compressed) {
      try { this.index(); } catch (e) { closeSync(this.fd); throw e; }
    }
  }

  private read(pos: number, len: number): Uint8Array {
    const b = new Uint8Array(len);
    const got = readSync(this.fd, b, 0, len, pos);
    return got === len ? b : b.subarray(0, got);
  }

  private headerLine(): Uint8Array {
    const parts: Uint8Array[] = [];
    for (let pos = 0; ; pos += 1 << 16) {
      const b = this.read(pos, 1 << 16), nl = b.indexOf(10);
      if (nl >= 0) { parts.push(b.subarray(0, nl + 1)); break; }
      if (!b.length) throw new ValueError("no header line");
      parts.push(b);
    }
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  /** the index entry at pos; null if not complete yet */
  private entry(pos: number, size: number): { scans: number; off: number; zlen: number; times: number[] } | null {
    if (pos + INDEX_SIZE > size) return null;
    const h = this.read(pos, INDEX_SIZE), v = new DataView(h.buffer);
    const magic = v.getUint32(0, true), n = v.getUint32(4, true), tag = new TextDecoder().decode(h.subarray(8, 12));
    const m = v.getUint32(12, true), zlen = v.getUint32(16, true);
    if (magic !== SKIP_MAGIC || tag !== INDEX_TAG || n !== 12 + 8 * m) throw new ValueError(`corrupt recording (bad index entry at byte ${pos})`);
    const off = pos + INDEX_SIZE + 8 * m;
    if (off + zlen > size) return null;
    const tv = new DataView(this.read(pos + INDEX_SIZE, 8 * m).buffer);
    return { scans: m, off, zlen, times: Array.from({ length: m }, (_, k) => tv.getFloat64(8 * k, true)) };
  }

  private index(): void {
    const size = statSync(this.path).size;
    for (let e; (e = this.entry(this.indexed, size)); ) {
      if (e.scans === 0) throw new ValueError(`corrupt recording (empty chunk at byte ${this.indexed})`);
      this.chunks.push([this.times.length, e.scans, e.off, e.zlen]);
      for (const t of e.times) this.times.push(t);
      this.indexed = e.off + e.zlen;
    }
  }

  /** complete scans (grows while the file is still being recorded) */
  get count(): number {
    if (this.compressed) { this.index(); return this.times.length; }
    return Math.max(0, Math.floor((statSync(this.path).size - this.header.length) / this.frameSize));
  }

  time(k: number): number {
    if (this.compressed) return this.times[k];
    return new DataView(this.read(this.header.length + k * this.frameSize, 8).buffer).getFloat64(0, true);
  }

  private chunk(c: number): Uint8Array {
    let data = this.cache.get(c);
    if (!data) {
      const [, m, off, zlen] = this.chunks[c];
      data = Bun.zstdDecompressSync(this.read(off, zlen));
      if (data.length !== m * this.frameSize) throw new ValueError(`corrupt recording (chunk ${c} has the wrong size)`);
      if (this.cache.size >= 2) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(c, data);
    }
    return data;
  }

  /** scan k: time, raw distances (12.5 mm units), rssi */
  raw(k: number): Frame {
    if (!(k >= 0 && k < this.count)) throw new RangeError(`frame ${k} out of range`);
    let frame: Uint8Array;
    if (this.compressed) {
      let lo = 0, hi = this.chunks.length - 1;                // the last chunk starting at or before k
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.chunks[mid][0] <= k) lo = mid; else hi = mid - 1; }
      const j = (k - this.chunks[lo][0]) * this.frameSize;
      frame = new Uint8Array(this.chunk(lo).subarray(j, j + this.frameSize));   // a copy (a Buffer's slice() is a view)
    } else frame = this.read(this.header.length + k * this.frameSize, this.frameSize);
    const n = this.n;
    return { t: new DataView(frame.buffer).getFloat64(0, true), d: new Uint16Array(frame.buffer, 8, n), r: new Uint16Array(frame.buffer, 8 + 2 * n, n) };
  }

  frames(first: number, end: number): Frame[] {
    const out: Frame[] = [];
    for (let k = first; k < end; k++) out.push(this.raw(k));
    return out;
  }

  scan(k: number): { t: number; scan: Scan } {
    const { t, d, r } = this.raw(k), { L, B, hdr } = this, scan = newScan(10);
    for (let l = 0; l < L; l++) {
      const distanceMm = new Float64Array(B), rssi = new Uint16Array(B);
      for (let b = 0; b < B; b++) { distanceMm[b] = d[l * B + b] * DIST_UNIT_MM; rssi[b] = r[l * B + b]; }
      scan.layers.push({ elevationDeg: hdr.elev[l * B + (B >> 1)], startAzimuthDeg: hdr.start_azimuth_deg, stepDeg: hdr.step_deg,
                         beamElevationDeg: Float64Array.from(hdr.elev.slice(l * B, (l + 1) * B)), echoes: [{ distanceMm, rssi }],
                         timestampUs: null, receivedS: null });
    }
    return { t, scan };
  }

  /** frame k in the /api/frame wire format (as frames.ts encode()), without building a Scan */
  encoded(k: number): { t: number; data: Uint8Array; points: number } {
    const { t, d, r } = this.raw(k), n = this.n, out = new Float32Array(3 * n);
    let points = 0;
    for (let i = 0; i < n; i++) { out[i] = d[i] * (DIST_UNIT_MM / 1000); if (d[i]) points++; }
    out.set(r, n);
    out.set(this.elev, 2 * n);
    return { t, data: new Uint8Array(out.buffer), points };
  }

  get sensors(): string[] { return [this.hdr.sensor || "sensor"]; }

  /** frame k as recorded (sensor, raw values, its header): what the server's own processing reads */
  rawFrame(k: number): { sensor: string; frame: Frame; hdr: Header } { return { sensor: this.sensors[0], frame: this.raw(k), hdr: this.hdr }; }

  frame(k: number): PublishedFrame {
    const { t, data, points } = this.encoded(k);
    return { sensor: this.sensors[0], t, data, points, hdr: this.hdr };
  }

  info(): RecordingInfo {
    const n = this.count, st = statSync(this.path);
    return { name: basename(this.path), bytes: st.size, scans: n, seconds: n > 1 ? round2(this.time(n - 1) - this.time(0)) : 0,
             created: n ? this.time(0) : st.mtimeMs / 1000 };
  }

  close(): void { try { closeSync(this.fd); } catch { /* closed */ } }
}

export const round2 = (x: number): number => Math.round(x * 100) / 100;
