// Shared test helpers: a real recorded scan, synthetic scans and telegrams, a fake CoLa sensor (TCP) and a fake
// REST sensor (HTTP). Ported from the Python backend's tests/conftest.py.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { colaPasswordHash, parseLmdScandata } from "../src/cola";
import { newScan, type Scan } from "../src/model";
import { frameValues, frameBytes, streamHeader } from "../src/recording/format";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** 24 LMDscandata telegrams (one scan) recorded from the MRS6224R on 2026-10-14 */
export function realTelegrams(): string[] {
  const text = new TextDecoder("latin1").decode(Bun.gunzipSync(readFileSync(join(FIXTURES, "scan_20261014.cola.txt.gz"))));
  return text.split("\n").map(l => l.replace(/\r$/, "")).filter(l => l.trim());
}

export function realScan(): Scan {
  const scan = newScan(10);
  for (const t of realTelegrams()) scan.layers.push(parseLmdScandata(t.split(" ").slice(2)).layer);
  return scan;
}

/** a small synthetic scan with exactly representable distances (multiples of 12.5 mm) */
export function makeScan(layers = 3, beams = 5, distMm = (l: number, b: number) => 1000 + 100 * l + b * 12.5,
                         rssi = (l: number, b: number) => 10 * l + b): Scan {
  const scan = newScan(10);
  for (let l = 0; l < layers; l++)
    scan.layers.push({ elevationDeg: -5 + l, startAzimuthDeg: -60, stepDeg: 0.5,
                       beamElevationDeg: Float64Array.from({ length: beams }, (_, b) => -5 + l + 0.01 * b),
                       echoes: [{ distanceMm: Float64Array.from({ length: beams }, (_, b) => distMm(l, b)), rssi: Uint16Array.from({ length: beams }, (_, b) => rssi(l, b)) }],
                       timestampUs: null, receivedS: null });
  return scan;
}

const hex32f = (x: number) => { const v = new DataView(new ArrayBuffer(4)); v.setFloat32(0, x); return v.getUint32(0).toString(16).toUpperCase().padStart(8, "0"); };

/** an LMDscandata telegram in the layout parseLmdScandata expects */
export function buildTelegram(layerAngleDeg: number, distRaw: number[], o: { rssi?: number[]; startDeg?: number; stepDeg?: number; vanglRaw?: number[]; counter?: number } = {}): string {
  const i16 = (v: number) => (v & 0xffff).toString(16).toUpperCase(), i32 = (v: number) => (v >>> 0).toString(16).toUpperCase(), h = (v: number) => v.toString(16).toUpperCase();
  const counter = o.counter ?? 1, start = o.startDeg ?? 30, step = o.stepDeg ?? 0.1301;
  const head = ["sSN", "LMDscandata", "1", "1", "155CC02", "0", "0", h(counter), h(counter), "E356EF3", "E3801AF", "0", "0", "0", "0",
                i16(Math.round(layerAngleDeg * 200)), "3E8", "229", "0"];
  const chans: [string, number, number, number[]][] = [["DIST1", 12.5, 0, distRaw]];
  if (o.rssi) chans.push(["RSSI1", 1, 0, o.rssi]);
  if (o.vanglRaw) chans.push(["VANGL", -0.00025, 1.5, o.vanglRaw]);
  const body = [h(chans.length)];
  for (const [name, scale, offset, raw] of chans)
    body.push(name, hex32f(scale), hex32f(offset), i32(Math.round(start * 10000)), h(Math.round(step * 10000)), h(raw.length), ...raw.map(h));
  return [...head, ...body].join(" ");
}

/** answers the CoLa commands the client uses and streams the given telegrams in a loop once LMDscandata is enabled */
export class FakeCola {
  commands: string[] = [];
  loggedIn = false;
  port = 0;
  private server: Server;
  private socks = new Set<Socket>();

  constructor(readonly telegrams: string[], readonly password = "secret", public echoFilter = 2, readonly maxScans: number | null = null) {
    this.server = createServer(sock => this.handle(sock));
  }

  static async start(telegrams: string[], o: { password?: string; echoFilter?: number; maxScans?: number | null } = {}): Promise<FakeCola> {
    const s = new FakeCola(telegrams, o.password, o.echoFilter, o.maxScans ?? null);
    await new Promise<void>(r => s.server.listen(0, "127.0.0.1", () => r()));
    s.port = (s.server.address() as { port: number }).port;
    return s;
  }

  private handle(sock: Socket): void {
    this.socks.add(sock);
    let buf = "", streaming = false, sent = 0, alive = true;
    const send = (msg: string) => { if (alive) sock.write(Buffer.from("\x02" + msg + "\x03", "latin1")); };
    const pump = () => {                       // one scan per tick while streaming
      if (!alive || !streaming) return;
      for (const t of this.telegrams) send(t);
      sent++;
      if (this.maxScans !== null && sent >= this.maxScans) { sock.destroy(); return; }   // drop the connection (sensor gone)
      setTimeout(pump, 5);
    };
    sock.on("close", () => { alive = false; this.socks.delete(sock); });
    sock.on("error", () => { alive = false; });
    sock.on("data", chunk => {
      buf += chunk.toString("latin1");
      for (let end; (end = buf.indexOf("\x03")) >= 0; ) {
        const cmd = buf.slice(buf.indexOf("\x02") + 1, end);
        buf = buf.slice(end + 1);
        this.commands.push(cmd);
        const reply = this.reply(cmd);
        if (reply) send(reply);
        if (cmd === "sEN LMDscandata 1" && !streaming) { streaming = true; setTimeout(pump, 0); }
        else if (cmd === "sEN LMDscandata 0") streaming = false;
      }
    });
  }

  reply(cmd: string): string | null {
    const p = cmd.split(" ");
    if (p[0] === "sEN" && p[1] === "LMDscandata") return `sEA LMDscandata ${p[2]}`;
    if (p[0] === "sMN" && p[1] === "SetAccessMode") {
      this.loggedIn = parseInt(p[3], 16) === colaPasswordHash(this.password);
      return `sAN SetAccessMode ${this.loggedIn ? 1 : 0}`;
    }
    if (p[0] === "sRN" && p[1] === "FREchoFilter") return `sRA FREchoFilter ${this.echoFilter}`;
    if (p[0] === "sWN" && p[1] === "FREchoFilter") {
      if (!this.loggedIn) return "sFA 2";
      this.echoFilter = Number(p[2]);
      return "sWA FREchoFilter";
    }
    if (p[0] === "sMN" && p[1] === "mEEwriteall") return "sAN mEEwriteall 1";
    if (p[0] === "sMN" && p[1] === "Run") { this.loggedIn = false; return "sAN Run 1"; }
    return "sFA 5";
  }

  async close(): Promise<void> {
    for (const s of this.socks) s.destroy();
    await new Promise<void>(r => this.server.close(() => r()));
  }
}

/** GET /api/<var> from `values`; getChallenge + checkCredentials / writes with SHA-256 auth */
export class FakeRest {
  static REALM = "SICK"; static NONCE = "abc123";
  posts: [string, Record<string, any>][] = [];
  private server: ReturnType<typeof Bun.serve>;
  readonly url: string;

  constructor(readonly values: Record<string, unknown>, readonly passwords: Record<string, string> = { Service: "servicelevel" }) {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => this.handle(req) });
    this.url = `http://127.0.0.1:${this.server.port}/api/`;
  }

  private async handle(req: Request): Promise<Response> {
    const name = new URL(req.url).pathname.replace(/^\/api\//, "");
    if (req.method === "GET") {
      return name in this.values ? Response.json({ header: { status: 0, message: "Ok" }, data: { [name]: this.values[name] } })
                                 : Response.json({ header: { status: 3, message: "Variable unknown" }, data: {} });
    }
    const body = await req.json() as Record<string, any>;
    this.posts.push([name, body]);
    if (name === "getChallenge") return Response.json({ challenge: { realm: FakeRest.REALM, nonce: FakeRest.NONCE, opaque: "o" } });
    const h = body.header, pw = this.passwords[h.user];
    const ok = pw !== undefined && h.response === FakeRest.expected(h.user, pw, name);
    if (ok && body.data) Object.assign(this.values, body.data);
    return Response.json({ header: { status: ok ? 0 : 4, message: ok ? "Ok" : "denied" } });
  }

  static expected(user: string, password: string, name: string): string {
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    return sha(`${sha(`${user}:${FakeRest.REALM}:${password}`)}:${FakeRest.NONCE}:${sha(`POST:${name}`)}`);
  }

  close(): void { this.server.stop(true); }
}

export const STATUS_VALUES: Record<string, unknown> = {
  CommonDeviceStatus: { Status: 3 }, OpHours: 1234, DailyOpHours: 5, PowerOnCnt: 7, KM_SysBoard_Temp: 41.5, KM_APDBoard_Temp: 35.7,
  KM_PowerSource_Voltage: 12.25, KM_MotorRotationPeriod: 100.0, KM_MotorRotationTime: 1, KMWindowWarning: false, KMWindowError: false,
  LinkToMeasurementModule: true, LED_1_RED: false, LED_2_ORANGE: false, LED_3_YELLOW: true,
  ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`DI${i + 1}`, false])), ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`DO${i + 1}`, i + 1 === 2])),
  AutoStartMeasure: true, UpsideDown: true, DeviceType: "MRS6224R-131001", SerialNumber: "123", FirmwareVersion: "2.1.0",
  EtherIPAddress: [192, 168, 178, 200], EtherMACAddress: [0, 6, 119, 1, 2, 3],
};

export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>(r => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

export async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutS = 5): Promise<void> {
  const end = Date.now() + timeoutS * 1000;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not reached");
    await Bun.sleep(10);
  }
}

/** a plain .tpc of `n` small scans */
export function writeRecording(path: string, n = 5, o: { layers?: number; beams?: number; dt?: number; t0?: number } = {}): string {
  const { layers = 3, beams = 5, dt = 0.1, t0 = 1000 } = o, parts: Uint8Array[] = [];
  for (let k = 0; k < n; k++) {
    const scan = makeScan(layers, beams, (l, b) => 1000 + 12.5 * (k + l + b));
    if (k === 0) parts.push(streamHeader(scan, true));
    parts.push(frameBytes({ t: t0 + k * dt, ...frameValues(scan) }));
  }
  writeFileSync(path, Buffer.concat(parts));
  return path;
}

/** a live source yielding the same small scan every dt seconds */
export const endless = (factory: () => Scan = () => makeScan(), dt = 0.01) => async function* () {
  for (;;) { yield factory(); await Bun.sleep(dt * 1000); }
};
