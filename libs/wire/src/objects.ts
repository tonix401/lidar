// What an object-detection client receives, version 1 (docs/api.md, "Object-detection server"). Objects are plain
// snapshots in the world frame (the rig's: x, y on the floor, z up, m), rounded to mm and 0.1°: ~200 bytes each.
//
//   client → proc   hello      {token?, name?, options?}       a registered client's token, or anonymous where open
//                   subscribe  {source: "live" | id}
//                   options    {options: ClientOptions}
//                   replay     {recording}                    a replay of its own, subscribed to at once
//                   control    {action, value?}               its replay's transport
//   proc → client   welcome    {client, options, sensors, sessions}
//                   subscribed {source, sensors, rig, replay}
//                   objects    {source, t, seq, objects: WorldObject[]}
//                   track      {source, event: "start" | "end", id, cls?, t}
//                   state      {source, replay, error}  ·  closed {source}  ·  error {message}

export const CLIENT_PROTOCOL = 1;

export const CLASSES = ["person", "moving object", "object", "static object"] as const;
export type TrackClass = (typeof CLASSES)[number];

/** one tracked object in the world frame */
export interface WorldObject {
  id: number;
  cls: TrackClass;
  x: number; y: number;             // centre of its box on the floor (m)
  vx: number; vy: number; speed: number;   // m/s
  box: { len: number; wid: number; yaw: number; z0: number; z1: number };   // m; yaw of `len` about z (degrees, −90..90)
  sensors: string[];                // the sensors that see it this scan
  age: number;                      // s since it was first seen
  moved: boolean;                   // has moved more than 0.5 m since
  trail?: number[];                 // recent x, y pairs (oldest first), with the client's `trails` option
}

/** how a client wants its objects: at most `rate` messages per second, only some classes, only inside a region of
 *  the floor, in its own coordinates (origin and yaw of its frame in the world), with trails */
export interface ClientOptions {
  rate?: number;
  classes?: TrackClass[];
  region?: [number, number][];      // a polygon, world x, y (m)
  transform?: { x: number; y: number; yaw: number };
  trails?: boolean;
}

const mm = (v: number) => Math.round(v * 1000) / 1000;

/** a client's view of the objects: only its classes and region, in its own frame, trails only when asked for */
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
