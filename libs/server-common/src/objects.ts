// Fused tracks as the clients see them (WorldObject, libs/wire/src/objects.ts): plain snapshots in the world frame,
// rounded to mm and 0.1°.
import type { FusedObject } from "@mrs6000/processing/fusion/objects";
import type { Track } from "@mrs6000/processing/objects/tracker";
import type { WorldObject } from "@mrs6000/wire/objects";

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
