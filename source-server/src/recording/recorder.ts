// Recording live scans to .tpc.zstd (format: format.ts). Chunks are compressed off the main thread
// (Bun.zstdCompress) and written in order, so compression never holds up the live stream. Disk errors stop the
// recording (with a message in state()), never the caller.
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { describeError } from "@mrs6000/server-common/errors";
import { log, stamp } from "@mrs6000/server-common/log";
import type { Scan } from "../model";
import { CHUNK_FRAMES, chunkData, FAST_LEVEL, frameValues, headerLine, headerOf, LEVEL, zstdEntryAsync, type Frame, type Header } from "./format";

export interface RecorderState { active: boolean; error: string; file?: string; scans?: number; bytes?: number; seconds?: number; sensors?: string[] }

/** one file being written: its descriptor, its write queue, whether a write failed (the rest is dropped) */
interface OpenFile { fd: number; writing: Promise<void>; pending: number; failed: boolean }

export class Recorder {
  path: string | null = null;
  scans = 0;
  bytes = 0;                               // written so far
  error = "";                              // also set by the writer
  upsideDown: boolean | null = null;
  sensor: string | null = null;            // written into the header (multi-sensor sessions)
  private file: OpenFile | null = null;
  private t0 = 0;
  private n = 0;                           // values per scan, from the first scan
  private frames: Frame[] = [];            // scans waiting for a full chunk

  constructor(readonly recDir: string, readonly chunkFrames = CHUNK_FRAMES) {}

  get active(): boolean { return this.file !== null && !this.error; }

  /** start (idempotent while recording); `path` defaults to rec_<time>.tpc.zstd in the folder */
  start(path: string | null = null): string {
    if (this.file) {
      if (!this.error) return this.path!;
      void this.close();
    }
    if (path === null) {
      mkdirSync(this.recDir, { recursive: true });
      path = join(this.recDir, `rec_${stamp()}.tpc.zstd`);
    }
    this.file = { fd: openSync(path, "w"), writing: Promise.resolve(), pending: 0, failed: false };
    this.path = path; this.scans = 0; this.t0 = Date.now() / 1000; this.error = ""; this.bytes = 0; this.n = 0; this.frames = [];
    log(`recording to ${path}`);
    return path;
  }

  write(scan: Scan, ts: number): void {
    if (!this.file) return;
    const { d, r } = frameValues(scan);
    this.writeFrame({ t: ts, d, r }, () => headerOf(scan, this.upsideDown, this.sensor));
  }

  /** one scan as recorded (time, uint16 distances and rssi); `header` describes the layout, asked for once */
  writeFrame(f: Frame, header: () => Header): void {
    if (!this.file) return;
    if (this.error) { void this.close(); return; }       // the writer failed
    if (!this.n) {
      this.n = f.d.length;
      this.queue(headerLine(header()), []);
    } else if (f.d.length !== this.n || f.r.length !== this.n) {
      this.error = "recording stopped: scan layout changed";
      log(this.error);
      void this.close();
      return;
    }
    this.frames.push(f);
    this.scans++;
    if (this.frames.length >= this.chunkFrames) { this.queue(chunkData(this.frames), this.frames.map(x => x.t)); this.frames = []; }
  }

  /** compress `data` (the header, or a chunk with its scan times), then write it after everything queued before */
  private queue(data: Uint8Array, times: number[]): void {
    const file = this.file!, z = zstdEntryAsync(data, times, file.pending < 2 ? LEVEL : FAST_LEVEL);
    file.pending++;
    file.writing = file.writing.then(async () => {
      try {
        const bytes = await z;
        if (file.failed) return;                          // drop the rest after a disk error
        writeSync(file.fd, bytes);
        if (this.file === file) this.bytes += bytes.length;
      } catch (e) {                                       // e.g. disk full: stop recording, keep streaming
        file.failed = true;
        if (this.file === file && !this.error) { this.error = `recording stopped: ${describeError(e)}`; log(this.error); }
      } finally {
        file.pending--;
      }
    });
  }

  /** write the last partial chunk, wait for the writer and close */
  private async close(): Promise<void> {
    const file = this.file;
    if (!file) return;
    if (this.frames.length) this.queue(chunkData(this.frames), this.frames.map(x => x.t));
    this.frames = [];
    this.file = null;
    await file.writing;
    try {
      closeSync(file.fd);
      if (!file.failed && !this.error) log(`recording saved: ${basename(this.path!)} (${this.scans} scans, ${(this.bytes / 1e6).toFixed(1)} MB)`);
    } catch (e) {
      log(`recording: ${describeError(e)}`);
    }
  }

  stop(): Promise<void> { return this.close(); }

  /** resolves once everything queued so far is on disk */
  flushed(): Promise<void> { return this.file?.writing ?? Promise.resolve(); }

  state(): RecorderState {
    if (!this.active) return { active: false, error: this.error };
    return { active: true, error: "", file: basename(this.path!), scans: this.scans, bytes: this.bytes,
             seconds: Math.round((Date.now() / 1000 - this.t0) * 10) / 10 };
  }
}
