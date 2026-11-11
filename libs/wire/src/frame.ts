// A scan as it travels between the servers: as recorded (uint16 distances in 12.5 mm units, uint16 rssi, layer-major)
// with its time on the host clock, plus the layout (Header) it belongs to, which is sent once per sensor and again
// whenever it changes (the elevation table is large).
//
// Binary frame message (one WebSocket message): uint32 n (little endian), n bytes of JSON meta (padded with spaces so
// the arrays start 4-byte aligned), then the uint16 distances and the uint16 rssi.

export const DIST_UNIT_MM = 12.5;

/** one scan as recorded: time (unix s, host clock), raw distances (12.5 mm units, 0 = invalid), rssi */
export interface Frame { t: number; d: Uint16Array; r: Uint16Array }

/** a sensor's scan layout: what a recording's header line holds */
export interface Header {
  layers: number; beams: number; start_azimuth_deg: number; step_deg: number; elev: number[];   // elev: layers × beams, degrees
  upside_down?: boolean; sensor?: string; [k: string]: unknown;
}

export function frameMessage(meta: Record<string, unknown>, d: Uint16Array, r: Uint16Array): Uint8Array {
  let head = new TextEncoder().encode(JSON.stringify(meta));
  const pad = (4 - ((4 + head.length) % 4)) % 4;
  if (pad) { const h = new Uint8Array(head.length + pad).fill(32); h.set(head); head = h; }
  const out = new Uint8Array(4 + head.length + 2 * d.length + 2 * r.length);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  out.set(new Uint8Array(d.buffer, d.byteOffset, d.byteLength), 4 + head.length);
  out.set(new Uint8Array(r.buffer, r.byteOffset, r.byteLength), 4 + head.length + d.byteLength);
  return out;
}

/** the other way round. The arrays are views into `b` (no copy: a WebSocket message's buffer is its own, and
 *  postMessage copies them anyway), or copies when `b` sits at an odd offset. */
export function readFrameMessage(b: Uint8Array): { meta: Record<string, unknown>; d: Uint16Array; r: Uint16Array } {
  const n = new DataView(b.buffer, b.byteOffset).getUint32(0, true), meta = JSON.parse(new TextDecoder().decode(b.subarray(4, 4 + n)));
  const rest = b.byteOffset % 2 === 0 ? b.subarray(4 + n) : b.slice(4 + n), half = rest.length / 4;
  return { meta, d: new Uint16Array(rest.buffer, rest.byteOffset, half), r: new Uint16Array(rest.buffer, rest.byteOffset + 2 * half, half) };
}
