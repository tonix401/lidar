// What clients receive, version 1 (docs/api.md, "WebSocket"). Objects are plain snapshots, rounded to mm and
// 0.1°: a message is ~200 bytes per object.
import type { FusedObject } from "@mrs6000/processing/fusion/objects";
import type { Track, TrackClass } from "@mrs6000/processing/objects/tracker";
import type { ClientOptions } from "./store";

export const PROTOCOL = 1;

/** one tracked object in the world frame (the rig's: x, y on the floor, z up, m) */
export interface WorldObject {
  id: number;
  cls: TrackClass;                  // person · moving object · object · static object
  x: number; y: number;             // centre of its box on the floor (m)
  vx: number; vy: number; speed: number;   // m/s
  box: { len: number; wid: number; yaw: number; z0: number; z1: number };   // m; yaw of `len` about z (degrees, −90..90)
  sensors: string[];                // the sensors that see it this scan
  age: number;                      // s since it was first seen
  moved: boolean;                   // has moved more than 0.5 m since
  trail?: number[];                 // recent x, y pairs (oldest first), with the client's `trails` option
}

const mm = (v: number) => Math.round(v * 1000) / 1000;

export function worldObject(t: Track, sensors: string[]): WorldObject {
  const b = t.box;
  return {
    id: t.id, cls: t.cls, x: mm(t.x + b.dx), y: mm(t.y + b.dy), vx: mm(t.vx), vy: mm(t.vy), speed: mm(t.speed),
    box: { len: mm(b.len), wid: mm(b.wid), yaw: Math.round((Math.atan2(b.s2, b.c2) / 2) * 1800 / Math.PI) / 10, z0: mm(b.z0), z1: mm(b.z1) },
    sensors, age: Math.round(t.age * 10) / 10, moved: t.moved, trail: t.trail.map(mm),
  };
}

export const worldObjects = (objects: FusedObject[], names: string[]): WorldObject[] =>
  objects.map(o => worldObject(o.track, o.sensors.map(k => names[k] ?? String(k))));

/** a client's view of the objects: only its classes and region, in its own frame (origin and yaw of its frame in the
 *  world), trails only when asked for */
export function forClient(objects: WorldObject[], o: ClientOptions): WorldObject[] {
  let out = objects;
  if (o.classes) out = out.filter(x => o.classes!.includes(x.cls));
  if (o.region) out = out.filter(x => inside(o.region!, x.x, x.y));
  if (o.transform) {
    const { x: ox, y: oy, yaw } = o.transform, c = Math.cos(yaw * Math.PI / 180), s = Math.sin(yaw * Math.PI / 180);
    const p = (x: number, y: number): [number, number] => [mm(c * (x - ox) + s * (y - oy)), mm(-s * (x - ox) + c * (y - oy))];
    const wrap = (a: number) => Math.round((((a + 90) % 180 + 180) % 180 - 90) * 10) / 10;
    out = out.map(x => {
      const [px, py] = p(x.x, x.y), trail: number[] = [];
      for (let i = 0; i + 1 < (x.trail?.length ?? 0); i += 2) trail.push(...p(x.trail![i], x.trail![i + 1]));
      return { ...x, x: px, y: py, vx: mm(c * x.vx + s * x.vy), vy: mm(-s * x.vx + c * x.vy), box: { ...x.box, yaw: wrap(x.box.yaw - yaw) }, trail };
    });
  }
  if (!o.trails) out = out.map(({ trail: _t, ...x }) => x);
  return out;
}

/** point in polygon (even-odd rule) */
export function inside(poly: [number, number][], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** A frame for debug clients, as one binary WebSocket message: uint32 n (little endian), n bytes of JSON (padded with
 *  spaces so the arrays start 4-byte aligned), then the uint16 distances (12.5 mm units) and the uint16 rssi. The
 *  layout (elevations) comes once per sensor as a "layout" message. */
export function frameMessage(meta: Record<string, unknown>, d: Uint16Array, r: Uint16Array): Uint8Array {
  let head = new TextEncoder().encode(JSON.stringify({ v: PROTOCOL, type: "frame", ...meta }));
  const pad = (4 - ((4 + head.length) % 4)) % 4;
  if (pad) { const h = new Uint8Array(head.length + pad).fill(32); h.set(head); head = h; }
  const out = new Uint8Array(4 + head.length + 2 * d.length + 2 * r.length);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  out.set(new Uint8Array(d.buffer, d.byteOffset, d.byteLength), 4 + head.length);
  out.set(new Uint8Array(r.buffer, r.byteOffset, r.byteLength), 4 + head.length + d.byteLength);
  return out;
}

/** the other way round (clients, tests) */
export function readFrameMessage(b: Uint8Array): { meta: Record<string, unknown>; d: Uint16Array; r: Uint16Array } {
  const n = new DataView(b.buffer, b.byteOffset).getUint32(0, true), meta = JSON.parse(new TextDecoder().decode(b.subarray(4, 4 + n)));
  const rest = b.slice(4 + n), half = rest.length / 4;
  return { meta, d: new Uint16Array(rest.buffer, 0, half), r: new Uint16Array(rest.buffer, 2 * half, half) };
}
