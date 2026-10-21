// Recordings: the format, random access, the recorder, conversion, and compatibility with files written by the
// Python backend (tests/fixtures/python_*, with what it served for them in python_expected.json).
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encode, metaForScan } from "../src/frames";
import { convert, listRecordings, recordingPath } from "../src/recording/catalog";
import { frameBytes, frameValues, streamChunk, streamHeader, zstdEntry } from "../src/recording/format";
import { Recording } from "../src/recording/reader";
import { Recorder } from "../src/recording/recorder";
import { Session } from "../src/recording/session";
import { FIXTURES, makeScan, realScan, waitUntil, writeRecording } from "./helpers";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rec-")); });
afterEach(() => { /* temp folders are left to the OS */ });

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const open = <T extends { close(): void }>(r: T, f: (r: T) => void) => { try { f(r); } finally { r.close(); } };

describe("recordings", () => {
  it("round trip and random access", () => open(new Recording(writeRecording(join(dir, "a.tpc"), 5)), r => {
    expect([r.count, r.L, r.B]).toEqual([5, 3, 5]);
    expect(r.hdr.upside_down).toBe(true);
    expect(r.time(3)).toBeCloseTo(1000.3, 9);
    const { scan } = r.scan(2);
    expect(scan.layers[1].echoes[0].distanceMm[4]).toBe(1000 + 12.5 * (2 + 1 + 4));
    Array.from(scan.layers[0].beamElevationDeg!).forEach((v, b) => expect(v).toBeCloseTo(-5 + 0.01 * b, 6));
    expect(r.info().scans).toBe(5);
    expect(r.info().seconds).toBeCloseTo(0.4, 9);
    expect(() => r.raw(5)).toThrow(RangeError);
  }));

  it("an encoded frame equals encoding the scan", () => open(new Recording(writeRecording(join(dir, "a.tpc"), 2)), r => {
    const { t, data, points } = r.encoded(1), { scan } = r.scan(1);
    expect(data).toEqual(encode(scan));
    expect(points).toBe(metaForScan(scan, 10, t).points);
    expect(points).toBe(15);
  }));

  it("the frame wire layout", () => {
    const f = new Float32Array(encode(makeScan(2, 3)).buffer);
    expect(f.length).toBe(3 * 6);
    expect(f[0]).toBeCloseTo(1, 6); expect(f[6 + 4]).toBe(11); expect(f[12]).toBeCloseTo(-5, 6);
  });

  it("partial frames are not counted", () => {
    const p = writeRecording(join(dir, "a.tpc"), 3);
    appendFileSync(p, new Uint8Array(10));
    open(new Recording(p), r => expect(r.count).toBe(3));
  });

  it("bad files are rejected and listed with their error", () => {
    writeFileSync(join(dir, "bad.tpc"), "not json\n");
    expect(() => new Recording(join(dir, "bad.tpc"))).toThrow(/not a .tpc recording/);
    writeRecording(join(dir, "good.tpc"));
    const byName = Object.fromEntries(listRecordings(dir).map(r => [r.name, r]));
    expect("error" in byName["bad.tpc"]).toBe(true);
    expect((byName["good.tpc"] as { scans: number }).scans).toBe(5);
    expect(listRecordings(join(dir, "missing"))).toEqual([]);
  });

  it("validates recording names", () => {
    writeRecording(join(dir, "ok.tpc"));
    writeRecording(join(dir, "ok.tpc.zstd"));
    expect(recordingPath(dir, "ok.tpc")).toBe(join(dir, "ok.tpc"));
    expect(recordingPath(dir, "ok.tpc.zstd")).toBe(join(dir, "ok.tpc.zstd"));
    for (const bad of ["../x.tpc", "a/b.tpc", "x.txt", "x.mrsstream", "x.tpc.zst", ""]) expect(() => recordingPath(dir, bad), bad).toThrow(/invalid recording name/);
    expect(() => recordingPath(dir, "nope.tpc")).toThrow(/nope.tpc/);
  });

  it("the recorder", async () => {
    const rec = new Recorder(join(dir, "recs"));
    expect(rec.state()).toEqual({ active: false, error: "" });
    rec.write(makeScan(), 1);                                    // inactive: ignored
    const path = rec.start();
    expect(rec.start()).toBe(path);                              // idempotent
    rec.upsideDown = false;
    for (let k = 0; k < 4; k++) rec.write(makeScan(), 1 + k / 10);
    const st = rec.state();
    expect([st.active, st.scans, st.file]).toEqual([true, 4, path.split("/").pop()]);
    await rec.stop();
    open(new Recording(path), r => { expect(r.count).toBe(4); expect(r.hdr.upside_down).toBe(false); });
  });

  it("the recorder stops on disk errors, the stream goes on", async () => {
    const rec = new Recorder(dir, 1);
    rec.start("/dev/full");                                      // opens, but every write fails: disk full
    rec.write(makeScan(), 1);                                    // must not throw (the writer fails)
    await waitUntil(() => !rec.state().active);
    expect(rec.state().error).toBe("recording stopped: no space left on device");
    rec.write(makeScan(), 1.1);                                  // closes the failed recording
    expect(rec.active).toBe(false);
  });

  it("the recorder stops when the scan layout changes", async () => {
    const rec = new Recorder(dir), path = rec.start();
    rec.write(makeScan(3, 5), 1);
    rec.write(makeScan(3, 6), 1.1);
    expect(rec.state()).toEqual({ active: false, error: "recording stopped: scan layout changed" });
    await rec.flushed(); await Bun.sleep(20);
    open(new Recording(path), r => expect(r.count).toBe(1));
  });

  it("the recorder writes a zstd stream of the .tpc, readable while recording", async () => {
    const rec = new Recorder(dir, 4), path = rec.start();
    expect(path.endsWith(".tpc.zstd")).toBe(true);
    const scans = Array.from({ length: 10 }, (_, k) => makeScan(3, 5, (l, b) => 1000 + 12.5 * (k * l + b)));
    scans.forEach((s, k) => rec.write(s, 100 + k / 10));
    const readable = () => { try { const r = new Recording(path); try { return r.count; } finally { r.close(); } } catch { return 0; } };
    await waitUntil(() => readable() === 8);                     // two full chunks
    await rec.stop();                                            // writes the partial third chunk
    open(new Recording(path), r => {
      expect([r.compressed, r.count, r.chunks.length]).toEqual([true, 10, 3]);
      for (const k of [9, 0, 5, 4]) {                            // random access across chunks
        const { t, scan } = r.scan(k);
        expect(t).toBeCloseTo(100 + k / 10, 9);
        expect(scan.layers.map(l => Array.from(l.echoes[0].distanceMm))).toEqual(scans[k].layers.map(l => Array.from(l.echoes[0].distanceMm)));
      }
    });
    const tpc = Buffer.concat([streamHeader(scans[0]), ...scans.map((s, k) => frameBytes({ t: 100 + k / 10, ...frameValues(s) }))]);
    expect(Buffer.from(Bun.zstdDecompressSync(readFileSync(path)))).toEqual(tpc);   // what `zstd -d` gives
  });

  it("a compressed recording grows and ignores incomplete chunks", () => {
    const raw = new Recording(writeRecording(join(dir, "a.tpc"), 7)), frames = raw.frames(0, 7), header = raw.header;
    raw.close();
    const p = join(dir, "a.tpc.zstd");
    writeFileSync(p, Buffer.concat([zstdEntry(header), streamChunk(frames.slice(0, 3))]));
    const second = streamChunk(frames.slice(3));
    open(new Recording(p), r => {
      expect(r.count).toBe(3);
      appendFileSync(p, second.subarray(0, -1));                 // being written
      expect(r.count).toBe(3);
      appendFileSync(p, second.subarray(-1));
      expect(r.count).toBe(7);
      expect(r.raw(6).t).toBe(frames[6].t);
      appendFileSync(p, Buffer.concat([Buffer.from("JUNK"), new Uint8Array(20)]));
      expect(() => r.count).toThrow(/corrupt/);
    });
  });

  it("convert round trip", async () => {
    const scan = realScan(), p = join(dir, "a.tpc");
    writeFileSync(p, Buffer.concat([streamHeader(scan, false), ...Array.from({ length: 60 }, (_, k) => frameBytes({ t: 1000 + k / 10, ...frameValues(scan) }))]));
    const original = readFileSync(p), z = join(dir, "a.tpc.zstd");
    const size = await convert(p, z);
    expect(size).toBe(statSync(z).size);
    expect(size).toBeLessThan(original.length / 5);
    expect(sha(Bun.zstdDecompressSync(readFileSync(z)))).toBe(sha(original));              // (toEqual on MBs is slow)
    open(new Recording(z), r => { expect([r.compressed, r.count, r.hdr.upside_down]).toEqual([true, 60, false]); });
    await convert(z, join(dir, "b.tpc"), false);
    expect(sha(readFileSync(join(dir, "b.tpc")))).toBe(sha(original));
    expect(readdirSync(dir).sort()).toEqual(["a.tpc", "a.tpc.zstd", "b.tpc"]);   // no temp files
  });

  it("plain zstd without the index is explained", () => {
    const p = writeRecording(join(dir, "a.tpc"));
    writeFileSync(join(dir, "b.tpc.zstd"), Bun.zstdCompressSync(readFileSync(p)));
    expect(() => new Recording(join(dir, "b.tpc.zstd"))).toThrow(/without the scan index/);
  });
});

describe("files written by the Python backend", () => {
  const exp = JSON.parse(readFileSync(join(FIXTURES, "python_expected.json"), "utf8"));

  it("a real-sensor recording: same frames, bytes, times and points", () => open(new Recording(join(FIXTURES, "python_real.tpc.zstd")), r => {
    expect([r.count, r.chunks.length, r.hdr.upside_down]).toEqual([exp.real.count, exp.real.chunks, exp.real.upside_down]);
    expect(Object.keys(r.hdr).sort()).toEqual(exp.real.hdr_keys);
    for (const f of exp.real.frames) {
      const e = r.encoded(f.k);
      expect([e.t, e.points, sha(e.data)]).toEqual([f.t, f.points, f.sha]);
    }
    const { t, scan } = r.scan(0);
    expect(sha(encode(scan))).toBe(exp.real.encode_scan0_sha);
    expect(metaForScan(scan, 10, t)).toEqual(exp.real.meta0);
    expect(r.info().scans).toBe(exp.real.info.scans);
    expect(r.info().seconds).toBeCloseTo(exp.real.info.seconds, 9);
  }));

  it("a two-sensor session: the same timeline", () => open(new Session(join(FIXTURES, "python_session")), s => {
    expect([s.count, s.sensors]).toEqual([exp.session.count, exp.session.sensors]);
    expect(Array.from({ length: s.count }, (_, k) => [s.frame(k).sensor, s.time(k)])).toEqual(exp.session.order);
    expect(sha(s.frame(4).data)).toBe(exp.session.sha4);
    expect(s.info().sensors).toEqual(exp.session.info.sensors);
    expect(s.info().seconds).toBeCloseTo(exp.session.info.seconds, 9);
  }));
});
