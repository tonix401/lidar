import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ColaClient, colaBFrame, colaPasswordHash, colaScans, parseLmdScandata, parseLmdScandataB, PermissionError } from "../src/cola";
import { beamCount, type Layer } from "../src/model";
import { buildTelegram, FakeCola, realColaBStream, realScan, realTelegrams, toColaB } from "./helpers";

const sensors: FakeCola[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of sensors.splice(0)) await s.close();
  for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()));
});
const fake = async (t: string[], o = {}) => { const s = await FakeCola.start(t, o); sensors.push(s); return s; };

/** the payloads of a CoLa B stream */
function colaBPayloads(stream: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [], v = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  for (let i = 0; i + 8 <= stream.length; ) { const n = v.getUint32(i + 4); out.push(stream.subarray(i + 8, i + 8 + n)); i += 9 + n; }
  return out;
}

/** a TCP server that sends `bytes` (in pieces of `piece`) to whoever connects, then keeps the connection open */
async function rawServer(bytes: Uint8Array, piece = 7): Promise<number> {
  const s = createServer(sock => {
    sock.on("error", () => {});
    for (let o = 0; o < bytes.length; o += piece) sock.write(bytes.subarray(o, o + piece));
  });
  servers.push(s);
  await new Promise<void>(r => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as { port: number }).port;
}

describe("CoLa", () => {
  it("password hash matches SICK's reference", () => {
    // sick_scan uses "sMN SetAccessMode 03 F4724744" for the AuthorizedClient password "client"
    expect(colaPasswordHash("client")).toBe(0xf4724744);
  });

  it("parses a synthetic telegram", () => {
    const t = buildTelegram(-2.5, [0, 15, 16, 80], { rssi: [1, 2, 3, 4], startDeg: 30, stepDeg: 0.1301, vanglRaw: [6000, 6000, 4000, 0] });
    const { layer, meta } = parseLmdScandata(t.split(" ").slice(2));
    expect(meta.layer_angle_deg).toBe(-2.5);
    expect(meta.scan_frequency_hz).toBe(10);
    expect(layer.startAzimuthDeg).toBeCloseTo(-60, 9);
    expect(layer.stepDeg).toBeCloseTo(0.1301, 9);
    expect(Array.from(layer.echoes[0].distanceMm)).toEqual([0, 0, 200, 1000]);       // raw <= 15 is invalid
    expect(Array.from(layer.echoes[0].rssi)).toEqual([1, 2, 3, 4]);
    Array.from(layer.beamElevationDeg!).forEach((v, i) => expect(v).toBeCloseTo([0, 0, 0.5, 1.5][i], 6));   // raw * -0.00025 + 1.5
  });

  it("parses a telegram without rssi or per-beam elevations", () => {
    const { layer } = parseLmdScandata(buildTelegram(1, [100, 200]).split(" ").slice(2));
    expect(Array.from(layer.echoes[0].rssi)).toEqual([0, 0]);
    expect(layer.beamElevationDeg).toBeNull();
  });

  it("rejects a telegram without distances", () => {
    const tokens = buildTelegram(1, [100]).split(" ").slice(2);
    tokens[tokens.indexOf("DIST1")] = "OTHER";
    expect(() => parseLmdScandata(tokens)).toThrow(/without distance/);
  });

  it("parses the real scan", () => {
    const scan = realScan(), first = scan.layers[0], last = scan.layers[23];
    expect(scan.layers.length).toBe(24);
    expect(beamCount(first)).toBe(923);
    expect(first.startAzimuthDeg).toBeCloseTo(-60, 9);
    expect(first.stepDeg).toBeCloseTo(0.1301, 9);
    expect(first.elevationDeg).toBeLessThan(last.elevationDeg);                       // bottom to top
    expect(first.beamElevationDeg!.length).toBe(923);
    const valid = Array.from(first.echoes[0].distanceMm).filter(d => d > 0);
    expect(valid.length).toBeGreaterThan(800);
    expect(valid.every(d => d % 12.5 === 0)).toBe(true);
    expect(Math.max(...first.echoes[0].rssi)).toBeGreaterThan(0);
  });

  it("groups layers into scans and drops the partial first one", async () => {
    const t = realTelegrams(), sensor = await fake([...t.slice(5), ...t]);   // starts mid-revolution, then whole scans
    const scans = colaScans("127.0.0.1", 24, sensor.port, 5, "A");
    const got = [(await scans.next()).value!, (await scans.next()).value!];
    expect(got.every(s => s.layers.length === 24)).toBe(true);
    expect(got[0].rawTelegrams.length).toBe(24);
    expect(got[0].layers.every((l: Layer) => l.receivedS! > 0 && l.timestampUs !== null)).toBe(true);
    await scans.return(undefined);                                                    // unsubscribes
    expect(sensor.commands).toContain("sEN LMDscandata 1");
  });

  it("logs in, reads, writes and saves", async () => {
    const sensor = await fake(realTelegrams()), c = await ColaClient.connect("127.0.0.1", sensor.port);
    try {
      expect(await c.read("FREchoFilter")).toEqual(["2"]);
      await expect(c.write("FREchoFilter", 1)).rejects.toThrow();                      // not logged in
      await expect(c.login("Service", "wrong")).rejects.toBeInstanceOf(PermissionError);
      await c.login("Service", "secret");
      await c.write("FREchoFilter", 1);
      await c.savePermanent();
      await c.run();
      expect(await c.read("FREchoFilter")).toEqual(["1"]);
      await expect(c.read("Unknown")).rejects.toThrow();
    } finally { c.close(); }
  });

  it("a closed connection ends the stream with an error", async () => {
    const sensor = await fake(realTelegrams(), { maxScans: 1 });
    await expect((async () => { for await (const _ of colaScans("127.0.0.1", 24, sensor.port, 5, "A")) { /* drain */ } })()).rejects.toThrow("sensor closed connection");
  });
});

describe("CoLa B", () => {
  it("parses a real scan recorded over CoLa B", () => {
    const layers = colaBPayloads(realColaBStream()).map(p => parseLmdScandataB(p, "sSN LMDscandata ".length));
    expect(layers.length).toBe(24);
    const first = layers[0].layer, last = layers[23].layer;
    expect(beamCount(first)).toBe(923);
    expect(first.startAzimuthDeg).toBeCloseTo(-60, 9);
    expect(first.stepDeg).toBeCloseTo(0.1301, 9);
    expect(layers.every((l, k) => k === 0 || l.layer.elevationDeg > layers[k - 1].layer.elevationDeg)).toBe(true);   // bottom to top
    expect(first.elevationDeg).toBeCloseTo(-13.19, 9);
    expect(last.elevationDeg).toBeCloseTo(1.185, 9);
    expect(first.beamElevationDeg!.length).toBe(923);
    expect(layers[0].meta.scan_frequency_hz).toBe(10);
    const valid = Array.from(first.echoes[0].distanceMm).filter(d => d > 0);
    expect(valid.length).toBeGreaterThan(800);
    expect(valid.every(d => d % 12.5 === 0)).toBe(true);
    expect(Math.max(...first.echoes[0].rssi)).toBeGreaterThan(0);
  });

  it("gives the same layers as CoLa A for the same telegrams", () => {
    const telegrams = [...realTelegrams(), buildTelegram(-2.5, [0, 15, 16, 80], { rssi: [1, 2, 3, 4], vanglRaw: [6000, 6000, 4000, 0] }),
                       buildTelegram(1, [100, 200])];
    for (const t of telegrams) expect(parseLmdScandataB(toColaB(t), "sSN LMDscandata ".length)).toEqual(parseLmdScandata(t.split(" ").slice(2)));
  });

  it("rejects a truncated telegram", () => {
    const p = toColaB(realTelegrams()[0]);
    expect(() => parseLmdScandataB(p.subarray(0, p.length - 10), 16)).toThrow(/truncated/);
  });

  it("streams scans and unsubscribes", async () => {
    const t = realTelegrams(), sensor = await fake([...t.slice(5), ...t], { dialect: "B" });
    const scans = colaScans("127.0.0.1", 24, sensor.port, 5, "B");
    const got = [(await scans.next()).value!, (await scans.next()).value!];
    expect(got.every(s => s.layers.length === 24)).toBe(true);
    const want = realScan();
    for (const s of got) s.layers.forEach((l: Layer, k: number) => {
      expect(l.echoes[0].distanceMm).toEqual(want.layers[k].echoes[0].distanceMm);
      expect(l.receivedS! > 0 && l.timestampUs !== null).toBe(true);
    });
    await scans.return(undefined);
    expect(sensor.commands).toContain("sEN LMDscandata 1");     // the binary argument byte, as sent
  });

  it("frames telegrams split across reads and after junk, dropping none", async () => {
    const payloads = colaBPayloads(realColaBStream());
    const bytes = Buffer.concat([Buffer.from("junk\x02\x02"), ...payloads.map(colaBFrame)]);   // junk that looks like a magic
    const c = await ColaClient.connect("127.0.0.1", await rawServer(bytes, 1000), 5, "B");
    try {
      for (let k = 0; k < payloads.length; k++) expect((await c.recv()).bytes).toEqual(payloads[k]);
    } finally { c.close(); }
  });

  it("a bad checksum ends the connection", async () => {
    const frame = colaBFrame(toColaB(realTelegrams()[0]));
    frame[frame.length - 1] ^= 0xff;
    const c = await ColaClient.connect("127.0.0.1", await rawServer(frame), 5, "B");
    try { await expect(c.recv()).rejects.toThrow(/checksum/); } finally { c.close(); }
  });

  it("configuration needs CoLa A", async () => {
    const sensor = await fake(realTelegrams(), { dialect: "B" }), c = await ColaClient.connect("127.0.0.1", sensor.port, 5, "B");
    try {
      await expect(c.read("FREchoFilter")).rejects.toThrow(/needs CoLa A/);
      await expect(c.login("Service", "secret")).rejects.toThrow(/needs CoLa A/);
    } finally { c.close(); }
  });
});
