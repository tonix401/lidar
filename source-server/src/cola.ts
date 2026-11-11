// CoLa client for the sensor's two dialects: CoLa A (TCP 2111, ASCII telegrams framed by STX/ETX) and CoLa B
// (TCP 2112, binary: 02 02 02 02, uint32 length, payload, XOR checksum). The scans come over CoLa B by default:
// half the bytes of CoLa A, and its fixed-width fields cost next to nothing to read. Configuration (login, read,
// write) needs CoLa A, whose arguments are text.
import { createHash } from "node:crypto";
import { connect, type Socket } from "node:net";
import { ConnectionError, ValueError } from "@mrs6000/server-common/errors";
import { nowS } from "@mrs6000/server-common/log";
import { DIST_INVALID_MAX_RAW, newScan, type Echo, type Layer, type Scan } from "./model";
import { DEFAULT_IP } from "./variables";

export const ECHO_FILTERS = { first: 0, all: 1, last: 2 } as const;   // FREchoFilter values
export const COLA_USER_LEVELS = { Maintenance: 2, AuthorizedClient: 3, Service: 4 } as const;

export type ColaDialect = "A" | "B";
export const COLA_PORTS: Record<ColaDialect, number> = { A: 2111, B: 2112 };

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

const signed = (v: number, bits: number): number => v >= 2 ** (bits - 1) ? v - 2 ** bits : v;
const f32 = new DataView(new ArrayBuffer(4));
const asFloat32 = (bits: number): number => { f32.setUint32(0, bits); return f32.getFloat32(0); };

export interface TelegramMeta {
  telegram_counter: number; scan_counter: number; time_since_startup_us: number; time_of_transmission_us: number;
  layer_angle_deg: number; scan_frequency_hz: number; measurement_frequency_hz: number;
}

/** A cursor over the space-separated tokens of an ASCII telegram, read straight from its bytes: a scan is ~66k
 *  hex tokens, and splitting them into strings for parseInt cost ~70 ms per scan. */
class Tokens {
  i: number;
  constructor(private b: Uint8Array, start = 0) { this.i = start; }

  /** the next token as an unsigned hex number (NaN if it holds anything else, as parseInt would give for junk) */
  hex(): number {
    const b = this.b, n = b.length;
    let i = this.i;
    while (i < n && b[i] === 0x20) i++;
    const start = i;
    let v = 0, bad = false;
    for (; i < n; i++) {
      const c = b[i];
      if (c === 0x20) break;
      if (c >= 0x30 && c <= 0x39) v = v * 16 + (c - 0x30);
      else if (c >= 0x41 && c <= 0x46) v = v * 16 + (c - 0x37);
      else if (c >= 0x61 && c <= 0x66) v = v * 16 + (c - 0x57);
      else bad = true;
    }
    this.i = i;
    return bad || i === start ? NaN : v;
  }

  /** the next token as text */
  str(): string {
    const b = this.b, n = b.length;
    let i = this.i;
    while (i < n && b[i] === 0x20) i++;
    const start = i;
    while (i < n && b[i] !== 0x20) i++;
    this.i = i;
    return latin1(b, start, i);
  }

  skip(k: number): void { for (let j = 0; j < k; j++) this.hex(); }

  /** the next `n` tokens as unsigned hex numbers into `out` (the hot loop: ~22k per telegram, kept flat) */
  hexes(out: Uint32Array, n: number): void {
    const b = this.b, len = b.length;
    let i = this.i;
    for (let k = 0; k < n; k++) {
      while (i < len && b[i] === 0x20) i++;
      const start = i;
      let v = 0, c = 0;
      for (; i < len && (c = b[i]) !== 0x20; i++) {
        const d = HEX[c];
        v = d < 0 ? NaN : v * 16 + d;
      }
      out[k] = i === start ? NaN : v;
    }
    this.i = i;
  }
}

/** hex digit values by character code, -1 for anything else */
const HEX = new Int8Array(256).fill(-1);
for (let c = 0; c < 10; c++) HEX[0x30 + c] = c;
for (let c = 0; c < 6; c++) HEX[0x41 + c] = HEX[0x61 + c] = 10 + c;

const latin1 = (b: Uint8Array, start = 0, end = b.length): string =>
  Buffer.from(b.buffer, b.byteOffset + start, end - start).toString("latin1");

/** Parse one LMDscandata telegram (the tokens after "sSN LMDscandata") into a Layer.
 *  Layout: header fields (counters, times, layer angle in 1/200°, scan frequency), encoder block, then 16-bit
 *  channels DIST1..n, RSSI1..n, VANGL, each: name, scale (float), offset (float), start angle (int32, 1e-4°),
 *  step (1e-4°), count, values. */
export function parseLmdScandata(t: string[]): { layer: Layer; meta: TelegramMeta } {
  return parseLmdScandataBytes(Buffer.from(t.join(" "), "latin1"));
}

/** a 16-bit channel of a telegram, its values as sent */
interface Channel { scale: number; offset: number; start: number; step: number; raw: Uint32Array | Uint16Array }

/** the same from the telegram's bytes, starting at `start` (the first token after "sSN LMDscandata") */
export function parseLmdScandataBytes(bytes: Uint8Array, start = 0): { layer: Layer; meta: TelegramMeta } {
  const tk = new Tokens(bytes, start), h: number[] = [];
  for (let k = 0; k < 16; k++) h.push(tk.hex());
  tk.skip(2 * tk.hex());                                  // encoder block
  const channels = new Map<string, Channel>();
  const nChan = tk.hex();
  for (let c = 0; c < nChan; c++) {
    const name = tk.str(), scale = asFloat32(tk.hex()), offset = asFloat32(tk.hex());
    const start = signed(tk.hex(), 32) / 10000, step = tk.hex() / 10000, n = tk.hex(), raw = new Uint32Array(n);
    tk.hexes(raw, n);
    channels.set(name, { scale, offset, start, step, raw });
  }
  return toLayer(h, channels);
}

/** widths in bytes of the 16 header fields in CoLa B: version, device number, serial number, device status (2),
 *  telegram counter, scan counter, time since start-up (µs), time of transmission (µs), input status (2), output
 *  status (2), layer angle (int16, 1/200°), scan frequency (1/100 Hz), measurement frequency (100 Hz) */
const B_HEADER = [2, 2, 4, 1, 1, 2, 2, 4, 4, 1, 1, 1, 1, 2, 4, 4];

/** a cursor over a CoLa B telegram's big-endian fields */
class Fields {
  constructor(private b: Uint8Array, public i: number) {}

  private need(n: number): void { if (this.i + n > this.b.length) throw new ValueError("truncated LMDscandata telegram"); }

  /** an unsigned integer of `w` bytes (1, 2 or 4) */
  u(w: number): number {
    this.need(w);
    const b = this.b, i = this.i;
    this.i += w;
    return w === 1 ? b[i] : w === 2 ? (b[i] << 8) | b[i + 1] : ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  }

  text(n: number): string { this.need(n); const s = latin1(this.b, this.i, this.i + n); this.i += n; return s; }

  skip(n: number): void { this.need(n); this.i += n; }

  /** `n` uint16 values */
  u16s(n: number): Uint16Array {
    this.need(2 * n);
    const b = this.b, out = new Uint16Array(n);
    let p = this.i;
    for (let k = 0; k < n; k++, p += 2) out[k] = (b[p] << 8) | b[p + 1];
    this.i = p;
    return out;
  }
}

/** The same telegram in CoLa B (the payload's bytes from `start`, the first field after "sSN LMDscandata "): the
 *  same fields in the same order, as big-endian integers of fixed width; channel names are 5 characters. */
export function parseLmdScandataB(bytes: Uint8Array, start = 0): { layer: Layer; meta: TelegramMeta } {
  const f = new Fields(bytes, start), h: number[] = [];
  for (const w of B_HEADER) h.push(f.u(w));
  f.skip(6 * f.u(2));                                     // encoder block: position uint32, speed uint16 each
  const channels = new Map<string, Channel>();
  const nChan = f.u(2);
  for (let c = 0; c < nChan; c++) {
    const name = f.text(5), scale = asFloat32(f.u(4)), offset = asFloat32(f.u(4)), first = signed(f.u(4), 32) / 10000;
    const step = f.u(2) / 10000, raw = f.u16s(f.u(2));
    channels.set(name, { scale, offset, start: first, step, raw });
  }
  return toLayer(h, channels);
}

/** a telegram's header fields and channels as a Layer */
function toLayer(h: number[], channels: Map<string, Channel>): { layer: Layer; meta: TelegramMeta } {
  const meta: TelegramMeta = {
    telegram_counter: h[5], scan_counter: h[6], time_since_startup_us: h[7], time_of_transmission_us: h[8],
    layer_angle_deg: signed(h[13], 16) / 200, scan_frequency_hz: h[14] / 100, measurement_frequency_hz: h[15] * 100,
  };
  const distNames = [...channels.keys()].filter(k => k.startsWith("DIST")).sort();
  if (!distNames.length) throw new ValueError("LMDscandata telegram without distance channel");
  const echoes: Echo[] = distNames.map(dn => {
    const { scale, offset, raw } = channels.get(dn)!, rs = channels.get("RSSI" + dn.slice(4));
    const distanceMm = new Float64Array(raw.length);
    for (let k = 0; k < raw.length; k++) distanceMm[k] = raw[k] > DIST_INVALID_MAX_RAW ? raw[k] * scale + offset : 0;
    return { distanceMm, rssi: rs ? new Uint16Array(rs.raw) : new Uint16Array(raw.length) };
  });
  const first = channels.get(distNames[0])!, va = channels.get("VANGL");
  let beamElevationDeg: Float64Array | null = null;
  if (va) {
    beamElevationDeg = new Float64Array(va.raw.length);
    for (let k = 0; k < va.raw.length; k++) beamElevationDeg[k] = va.raw[k] * va.scale + va.offset;
  }
  const layer: Layer = {
    elevationDeg: meta.layer_angle_deg, startAzimuthDeg: first.start - 90, stepDeg: first.step, echoes,
    beamElevationDeg, timestampUs: meta.time_since_startup_us, receivedS: null,
  };
  return { layer, meta };
}

/** a received telegram: its bytes (without STX/ETX, or CoLa B's header and checksum); `text` decodes them as
 *  latin1 (replies are short, scans are not) */
interface Telegram { bytes: Uint8Array; receivedS: number; readonly text: string }

const telegram = (bytes: Uint8Array, receivedS: number): Telegram => ({
  bytes, receivedS, get text() { return latin1(bytes); },
});

/** does the telegram start with `prefix` (ASCII)? */
function startsWith(b: Uint8Array, prefix: string): boolean {
  if (b.length < prefix.length) return false;
  for (let k = 0; k < prefix.length; k++) if (b[k] !== prefix.charCodeAt(k)) return false;
  return true;
}

const SCAN_PREFIXES = ["sSN LMDscandata ", "sRA LMDscandata "];

const B_MAGIC = Buffer.from([2, 2, 2, 2]);
const B_MAX_PAYLOAD = 1 << 20;               // a scan telegram is ~6 kB; more means the stream lost its place

/** a CoLa B frame around `payload` */
export function colaBFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(9 + payload.length), v = new DataView(out.buffer);
  out.set(B_MAGIC, 0); v.setUint32(4, payload.length);
  out.set(payload, 8);
  let x = 0;
  for (const b of payload) x ^= b;
  out[8 + payload.length] = x;
  return out;
}

/** Minimal CoLa client (A or B). */
export class ColaClient {
  private pending: Uint8Array[] = [];        // received bytes of the telegram not complete yet
  private queue: Telegram[] = [];
  private waiting: { resolve: (t: Telegram) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;

  private constructor(private sock: Socket, private timeoutMs: number, readonly dialect: ColaDialect) {
    sock.setNoDelay(true);
    sock.on("data", (chunk: Buffer) => { if (dialect === "B") this.receivedB(chunk); else this.received(chunk); });
    sock.on("error", e => this.fail(e));
    sock.on("close", () => this.fail(new ConnectionError("sensor closed connection")));
  }

  static connect(ip: string = DEFAULT_IP, port?: number, timeoutS = 5, dialect: ColaDialect = "A"): Promise<ColaClient> {
    return new Promise((resolve, reject) => {
      const sock = connect({ host: ip, port: port ?? COLA_PORTS[dialect] });
      const timer = setTimeout(() => { sock.destroy(); reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })); }, timeoutS * 1000);
      sock.once("connect", () => { clearTimeout(timer); resolve(new ColaClient(sock, timeoutS * 1000, dialect)); });
      sock.once("error", e => { clearTimeout(timer); reject(e); });
    });
  }

  close(): void { this.sock.destroy(); }

  /** send a command: its text, then (CoLa B) binary arguments as bytes */
  send(cmd: string, binArgs: number[] = []): void {
    if (this.dialect === "A") { this.sock.write(Buffer.from("\x02" + cmd + "\x03", "latin1")); return; }
    this.sock.write(colaBFrame(Buffer.concat([Buffer.from(cmd, "latin1"), Uint8Array.from(binArgs)])));
  }

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

  // --- configuration (needs login; CoLa A only: the arguments below are written and read as text) ---

  private needA(what: string): void {
    if (this.dialect !== "A") throw new ValueError(`${what} needs CoLa A (port ${COLA_PORTS.A})`);
  }

  /** SetAccessMode with SICK's CoLa password hash; rejected → an error */
  async login(user: keyof typeof COLA_USER_LEVELS, password: string): Promise<void> {
    this.needA("login");
    const level = COLA_USER_LEVELS[user];
    const r = await this.request(`sMN SetAccessMode ${hex(level, 2)} ${hex(colaPasswordHash(password), 8)}`);
    if (r.split(" ").pop() !== "1") throw new PermissionError(`CoLa login as ${user} rejected (${r})`);
  }

  async read(name: string): Promise<string[]> {
    this.needA("sRN");
    const r = await this.request(`sRN ${name}`);
    if (r.startsWith("sFA")) throw new Error(`sRN ${name}: error ${r}`);
    return r.split(" ").slice(2);
  }

  async write(name: string, ...values: (string | number)[]): Promise<void> {
    this.needA("sWN");
    const r = await this.request(`sWN ${name} ` + values.join(" "));
    if (!r.startsWith("sWA")) throw new Error(`sWN ${name}: error ${r}`);
  }

  /** store the current parameters in EEPROM (otherwise lost on power cycle) */
  async savePermanent(): Promise<void> {
    this.needA("mEEwriteall");
    const r = await this.request("sMN mEEwriteall");
    if (r.split(" ").pop() !== "1") throw new Error(`mEEwriteall failed (${r})`);
  }

  /** leave configuration mode / log out (back to user level Run) */
  async run(): Promise<void> { await this.request("sMN Run"); }

  // --- scan stream ---

  /** LMDscandata on or off (CoLa A: the text "1"/"0"; CoLa B: one byte) */
  private subscribe(on: boolean): void {
    if (this.dialect === "A") this.send(`sEN LMDscandata ${on ? 1 : 0}`);
    else this.send("sEN LMDscandata ", [on ? 1 : 0]);
  }

  /** subscribe to LMDscandata and yield complete multi-layer scans */
  async *scans(): AsyncGenerator<Scan> {
    this.subscribe(true);
    const parse = this.dialect === "B" ? parseLmdScandataB : parseLmdScandataBytes;
    let current = newScan(), lastAngle: number | null = null, freq: number | null = null;
    try {
      for (;;) {
        const t = await this.recv();
        const prefix = SCAN_PREFIXES.find(p => startsWith(t.bytes, p));
        if (!prefix) continue;
        const { layer, meta } = parse(t.bytes, prefix.length);
        layer.receivedS = t.receivedS;
        // layers arrive bottom-to-top; a non-increasing angle starts a new revolution
        if (lastAngle !== null && layer.elevationDeg <= lastAngle && current.layers.length) {
          current.scanFrequencyHz = freq;
          yield current;
          current = newScan();
        }
        current.layers.push(layer);
        current.rawTelegrams.push(t.text);
        lastAngle = layer.elevationDeg; freq = meta.scan_frequency_hz;
      }
    } finally {
      try { if (!this.failure) this.subscribe(false); } catch { /* gone */ }
    }
  }

  private deliver(t: Telegram): void {
    if (this.waiting) { const w = this.waiting; this.waiting = null; w.resolve(t); } else this.queue.push(t);
  }

  /** cut telegrams at ETX, from the last STX before it; the bytes are copied, the socket's chunk is not kept */
  private received(chunk: Uint8Array): void {
    const at = nowS();
    let from = 0;
    for (;;) {
      const end = chunk.indexOf(0x03, from);
      if (end < 0) break;
      let body: Uint8Array;
      if (this.pending.length) { this.pending.push(chunk.subarray(from, end)); body = Buffer.concat(this.pending); this.pending = []; }
      else body = new Uint8Array(chunk.subarray(from, end));
      from = end + 1;
      this.deliver(telegram(body.subarray(body.lastIndexOf(0x02) + 1), at));
    }
    if (from < chunk.length) this.pending.push(new Uint8Array(chunk.subarray(from)));
  }

  /** CoLa B: 02 02 02 02, uint32 payload length (big endian), payload, XOR of the payload. Bytes before a magic, or
   *  a "magic" followed by an impossible length, are skipped; a bad checksum ends the connection (the stream lost its
   *  place: reconnect). */
  private receivedB(chunk: Buffer): void {
    const at = nowS();
    const buf = this.pending.length ? Buffer.concat([...this.pending, chunk]) : chunk;
    this.pending = [];
    let i = 0;
    while (buf.length - i >= 8) {
      if (buf[i] !== 2 || buf[i + 1] !== 2 || buf[i + 2] !== 2 || buf[i + 3] !== 2) {
        const j = buf.indexOf(B_MAGIC, i + 1);
        i = j < 0 ? Math.max(i, buf.length - 3) : j;
        if (j < 0) break;
        continue;
      }
      const len = buf.readUInt32BE(i + 4);
      if (len > B_MAX_PAYLOAD) { i++; continue; }          // not a frame start after all
      if (buf.length - i < 9 + len) break;
      const payload = new Uint8Array(buf.subarray(i + 8, i + 8 + len));
      let x = 0;
      for (let k = 0; k < len; k++) x ^= payload[k];
      if (x !== buf[i + 8 + len]) return this.broken("CoLa B: checksum mismatch");
      i += 9 + len;
      this.deliver(telegram(payload, at));
    }
    if (i < buf.length) this.pending.push(new Uint8Array(buf.subarray(i)));
  }

  private broken(why: string): void { this.fail(new ConnectionError(why)); this.sock.destroy(); }

  private fail(e: Error): void {
    this.failure ??= e;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w.reject(this.failure); }
  }
}

export class PermissionError extends Error { override name = "PermissionError"; }

const hex = (v: number, width: number) => v.toString(16).toUpperCase().padStart(width, "0");

/** full-rate scans with all `layers` layers (drops the partial first revolution), over CoLa B unless told otherwise
 *  (`port`: the dialect's own by default) */
export async function* colaScans(ip: string = DEFAULT_IP, layers = 24, port?: number, timeoutS = 5,
                                 dialect: ColaDialect = "B"): AsyncGenerator<Scan> {
  const c = await ColaClient.connect(ip, port, timeoutS, dialect);
  try {
    for await (const scan of c.scans()) if (scan.layers.length === layers) yield scan;
  } finally {
    c.close();
  }
}
