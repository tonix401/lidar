import { afterEach, describe, expect, it } from "vitest";
import { ColaClient, colaPasswordHash, colaScans, parseLmdScandata, PermissionError } from "../src/cola";
import { beamCount, type Layer } from "../src/model";
import { buildTelegram, FakeCola, realScan, realTelegrams } from "./helpers";

const sensors: FakeCola[] = [];
afterEach(async () => { for (const s of sensors.splice(0)) await s.close(); });
const fake = async (t: string[], o = {}) => { const s = await FakeCola.start(t, o); sensors.push(s); return s; };

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
    const scans = colaScans("127.0.0.1", 24, sensor.port);
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
    await expect((async () => { for await (const _ of colaScans("127.0.0.1", 24, sensor.port)) { /* drain */ } })()).rejects.toThrow("sensor closed connection");
  });
});
