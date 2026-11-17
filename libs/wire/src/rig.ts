// The rig: where the sensors are. The source server owns it (its settings database for the live sensors, each
// file's header for a recording) and sends it to every processing server with the frames.
//
//   {"sensors": [{"name": "a", "main": true, "pose": {"x": 0, "y": 0, "z": 1.1, "yaw": 0},
//                 "time_offset_s": 0.0, "calibrated": "2026-10-20T12:00:00", "quality": {...}}]}
//
// Every sensor is mounted level: a pose is a position in m and a yaw about z in degrees (libs/processing/src/fusion/pose.ts).
// The world is the floor below the main sensor (`main`, exactly one): its pose is (0, 0, its height, 0).

export const POSE_KEYS = ["x", "y", "z", "yaw"] as const;

export type Pose = Record<(typeof POSE_KEYS)[number], number>;
/** `region`: a polygon of world x, y pairs (m); beams of this sensor outside it are cut from the point cloud (the source server drops them) */
export interface RigSensor { name: string; main?: boolean; pose?: Pose; time_offset_s?: number; calibrated?: string; quality?: unknown; region?: [number, number][]; [k: string]: unknown }
export interface Rig { sensors: RigSensor[]; [k: string]: unknown }

/** the entries of `names`, in that order (sensors without one get just their name) */
export function rigFor(rig: Rig, names: string[]): Rig {
  const byName = new Map((rig.sensors ?? []).map(s => [s.name, s]));
  return { sensors: names.map(n => byName.get(n) ?? { name: n }) };
}

/** the main sensor's name: the one marked so, else the first */
export const mainOf = (rig: { sensors?: readonly { name: string; main?: boolean }[] }): string | undefined =>
  (rig.sensors ?? []).find(s => s.main)?.name ?? rig.sensors?.[0]?.name;
