// The rig: where the sensors are. The source server owns it (source.json for the live sensors, the `rig` key of a
// session's session.json for a recording) and sends it to every processing server with the frames.
//
//   {"sensors": [{"name": "a", "pose": {"x": 0, "y": 0, "z": 1.1, "yaw": 0, "pitch": 0, "roll": 0},
//                 "time_offset_s": 0.0, "calibrated": "2026-10-20T12:00:00", "quality": {...}}]}
//
// Positions in m, angles in degrees (yaw about z, then pitch, then roll; see libs/processing/src/fusion/pose.ts).

export const POSE_KEYS = ["x", "y", "z", "yaw", "pitch", "roll"] as const;

export type Pose = Record<(typeof POSE_KEYS)[number], number>;
export interface RigSensor { name: string; pose?: Pose; time_offset_s?: number; calibrated?: string; quality?: unknown; [k: string]: unknown }
export interface Rig { sensors: RigSensor[]; [k: string]: unknown }

/** the entries of `names`, in that order (sensors without one get just their name) */
export function rigFor(rig: Rig, names: string[]): Rig {
  const byName = new Map((rig.sensors ?? []).map(s => [s.name, s]));
  return { sensors: names.map(n => byName.get(n) ?? { name: n }) };
}
