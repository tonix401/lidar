// CoLa A client (TCP 2111, ASCII telegrams framed by STX/ETX): full-rate scans and configuration.
import { createHash } from "node:crypto";
import { connect, type Socket } from "node:net";
import { ConnectionError, ValueError } from "@mrs6000/server-common/errors";
import { nowS } from "@mrs6000/server-common/log";
import { DIST_INVALID_MAX_RAW, newScan, type Echo, type Layer, type Scan } from "./model";
import { DEFAULT_IP } from "./variables";

export const ECHO_FILTERS = { first: 0, all: 1, last: 2 } as const;   // FREchoFilter values
export const COLA_USER_LEVELS = { Maintenance: 2, AuthorizedClient: 3, Service: 4 } as const;

const ISO_8859_15: Record<string, number> = { "€": 0xa4, "Š": 0xa6, "š": 0xa8, "Ž": 0xb4, "ž": 0xb8, "Œ": 0xbc, "œ": 0xbd, "Ÿ": 0xbe };
const NOT_IN_15 = new Set([0xa4, 0xa6, 0xa8, 0xb4, 0xb8, 0xbc, 0xbd, 0xbe]);

/** SICK CoLa A/B password hash: MD5 of the ISO-8859-15 bytes, XOR-folded to 4 bytes, little-endian uint32 */
export function colaPasswordHash(password: string): number {
  const bytes = [...password].map(ch => {
    const c = ch.codePointAt(0)!;
    if (ch in ISO_8859_15) return ISO_8859_15[ch];
    if (c > 0xff || NOT_IN_15.has(c)) throw new ValueError(`password character ${ch} is not in ISO-8859-15`);
    return c;
  });
  const d = createHash("md5").update(Uint8Array.from(bytes)).digest();
  const f = [0, 1, 2, 3].map(i => d[i] ^ d[i + 4] ^ d[i + 8] ^ d[i + 12]);
  return (f[0] | (f[1] << 8) | (f[2] << 16) | (f[3] << 24)) >>> 0;
}

const hexI = (tok: string, bits: number): number => { const v = parseInt(tok, 16); return v >= 2 ** (bits - 1) ? v - 2 ** bits : v; };
const f32 = new DataView(new ArrayBuffer(4));
const hexF = (tok: string): number => { f32.setUint32(0, parseInt(tok, 16)); return f32.getFloat32(0); };

export interface TelegramMeta {
  telegram_counter: number; scan_counter: number; time_since_startup_us: number; time_of_transmission_us: number;
  layer_angle_deg: number; scan_frequency_hz: number; measurement_frequency_hz: number;
}

/** Parse one LMDscandata telegram (the tokens after "sSN LMDscandata") into a Layer.
 *  Layout: header fields (counters, times, layer angle in 1/200°, scan frequency), encoder block, then 16-bit
 *  channels DIST1..n, RSSI1..n, VANGL, each: name, scale (float), offset (float), start angle (int32, 1e-4°),
 *  step (1e-4°), count, values. */
export function parseLmdScandata(t: string[]): { layer: Layer; meta: TelegramMeta } {
  const meta: TelegramMeta = {
    telegram_counter: parseInt(t[5], 16), scan_counter: parseInt(t[6], 16),
    time_since_startup_us: parseInt(t[7], 16), time_of_transmission_us: parseInt(t[8], 16),
    layer_angle_deg: hexI(t[13], 16) / 200, scan_frequency_hz: parseInt(t[14], 16) / 100,
    measurement_frequency_hz: parseInt(t[15], 16) * 100,
  };
  let i = 16;
  const nEnc = parseInt(t[i], 16);
  i += 1 + 2 * nEnc;
  const channels = new Map<string, { scale: number; offset: number; start: number; step: number; raw: Uint32Array }>();
  const nChan = parseInt(t[i], 16);
  i += 1;
  for (let c = 0; c < nChan; c++) {
    const name = t[i], n = parseInt(t[i + 5], 16), raw = new Uint32Array(n);
    for (let k = 0; k < n; k++) raw[k] = parseInt(t[i + 6 + k], 16);
    channels.set(name, { scale: hexF(t[i + 1]), offset: hexF(t[i + 2]), start: hexI(t[i + 3], 32) / 10000, step: parseInt(t[i + 4], 16) / 10000, raw });
    i += 6 + n;
  }
  const distNames = [...channels.keys()].filter(k => k.startsWith("DIST")).sort();
  if (!distNames.length) throw new ValueError("LMDscandata telegram without distance channel");
  const echoes: Echo[] = distNames.map(dn => {
    const { scale, offset, raw } = channels.get(dn)!, rs = channels.get("RSSI" + dn.slice(4));
    const distanceMm = new Float64Array(raw.length);
    for (let k = 0; k < raw.length; k++) distanceMm[k] = raw[k] > DIST_INVALID_MAX_RAW ? raw[k] * scale + offset : 0;
    return { distanceMm, rssi: rs ? Uint16Array.from(rs.raw) : new Uint16Array(raw.length) };
  });
  const first = channels.get(distNames[0])!, va = channels.get("VANGL");
  const layer: Layer = {
    elevationDeg: meta.layer_angle_deg, startAzimuthDeg: first.start - 90, stepDeg: first.step, echoes,
    beamElevationDeg: va ? Float64Array.from(va.raw, r => r * va.scale + va.offset) : null,
    timestampUs: meta.time_since_startup_us, receivedS: null,
  };
  return { layer, meta };
}

interface Telegram { text: string; receivedS: number }

/** Minimal CoLa A client. */
export class ColaClient {
  private buf = "";
  private queue: Telegram[] = [];
  private waiting: { resolve: (t: Telegram) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;

  private constructor(private sock: Socket, private timeoutMs: number) {
    sock.setNoDelay(true);
    sock.on("data", chunk => this.received(chunk.toString("latin1")));
    sock.on("error", e => this.fail(e));
    sock.on("close", () => this.fail(new ConnectionError("sensor closed connection")));
  }

  static connect(ip: string = DEFAULT_IP, port = 2111, timeoutS = 5): Promise<ColaClient> {
    return new Promise((resolve, reject) => {
      const sock = connect({ host: ip, port });
      const timer = setTimeout(() => { sock.destroy(); reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })); }, timeoutS * 1000);
      sock.once("connect", () => { clearTimeout(timer); resolve(new ColaClient(sock, timeoutS * 1000)); });
      sock.once("error", e => { clearTimeout(timer); reject(e); });
    });
  }

  close(): void { this.sock.destroy(); }

  send(cmd: string): void { this.sock.write(Buffer.from("\x02" + cmd + "\x03", "latin1")); }

  /** the next telegram (frames are cut at ETX, from the last STX before it) */
  recv(): Promise<Telegram> {
    const t = this.queue.shift();
    if (t) return Promise.resolve(t);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting = null; reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })); }, this.timeoutMs);
      this.waiting = { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } };
    });
  }

  /** send a command and return the matching reply (skips interleaved scan telegrams) */
  async request(cmd: string): Promise<string> {
    this.send(cmd);
    const name = cmd.split(" ")[1];
    for (;;) {
      const { text } = await this.recv();
      if (text.split(" ", 3)[1] === name || text.startsWith("sFA")) return text;
    }
  }

  // --- configuration (needs login) ---

  /** SetAccessMode with SICK's CoLa password hash; rejected → an error */
  async login(user: keyof typeof COLA_USER_LEVELS, password: string): Promise<void> {
    const level = COLA_USER_LEVELS[user];
    const r = await this.request(`sMN SetAccessMode ${hex(level, 2)} ${hex(colaPasswordHash(password), 8)}`);
    if (r.split(" ").pop() !== "1") throw new PermissionError(`CoLa login as ${user} rejected (${r})`);
  }

  async read(name: string): Promise<string[]> {
    const r = await this.request(`sRN ${name}`);
    if (r.startsWith("sFA")) throw new Error(`sRN ${name}: error ${r}`);
    return r.split(" ").slice(2);
  }

  async write(name: string, ...values: (string | number)[]): Promise<void> {
    const r = await this.request(`sWN ${name} ` + values.join(" "));
    if (!r.startsWith("sWA")) throw new Error(`sWN ${name}: error ${r}`);
  }

  /** store the current parameters in EEPROM (otherwise lost on power cycle) */
  async savePermanent(): Promise<void> {
    const r = await this.request("sMN mEEwriteall");
    if (r.split(" ").pop() !== "1") throw new Error(`mEEwriteall failed (${r})`);
  }

  /** leave configuration mode / log out (back to user level Run) */
  async run(): Promise<void> { await this.request("sMN Run"); }

  // --- scan stream ---

  /** subscribe to LMDscandata and yield complete multi-layer scans */
  async *scans(): AsyncGenerator<Scan> {
    this.send("sEN LMDscandata 1");
    let current = newScan(), lastAngle: number | null = null, freq: number | null = null;
    try {
      for (;;) {
        const { text, receivedS } = await this.recv();
        const tok = text.split(" ");
        if (tok.length < 2 || tok[1] !== "LMDscandata" || (tok[0] !== "sSN" && tok[0] !== "sRA")) continue;
        const { layer, meta } = parseLmdScandata(tok.slice(2));
        layer.receivedS = receivedS;
        // layers arrive bottom-to-top; a non-increasing angle starts a new revolution
        if (lastAngle !== null && layer.elevationDeg <= lastAngle && current.layers.length) {
          current.scanFrequencyHz = freq;
          yield current;
          current = newScan();
        }
        current.layers.push(layer);
        current.rawTelegrams.push(text);
        lastAngle = layer.elevationDeg; freq = meta.scan_frequency_hz;
      }
    } finally {
      try { if (!this.failure) this.send("sEN LMDscandata 0"); } catch { /* gone */ }
    }
  }

  private received(chunk: string): void {
    const at = nowS();
    this.buf += chunk;
    for (;;) {
      const end = this.buf.indexOf("\x03");
      if (end < 0) break;
      const start = this.buf.lastIndexOf("\x02", end);
      const t: Telegram = { text: this.buf.slice(start + 1, end), receivedS: at };
      this.buf = this.buf.slice(end + 1);
      if (this.waiting) { const w = this.waiting; this.waiting = null; w.resolve(t); } else this.queue.push(t);
    }
  }

  private fail(e: Error): void {
    this.failure ??= e;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w.reject(this.failure); }
  }
}

export class PermissionError extends Error { override name = "PermissionError"; }

const hex = (v: number, width: number) => v.toString(16).toUpperCase().padStart(width, "0");

/** full-rate scans with all `layers` layers (drops the partial first revolution) */
export async function* colaScans(ip: string = DEFAULT_IP, layers = 24, port = 2111, timeoutS = 5): AsyncGenerator<Scan> {
  const c = await ColaClient.connect(ip, port, timeoutS);
  try {
    for await (const scan of c.scans()) if (scan.layers.length === layers) yield scan;
  } finally {
    c.close();
  }
}
