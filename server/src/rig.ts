// The rig: which sensors there are (name, address) and where they are (pose in the world frame, residual clock
// offset, how it was calibrated). Stored as JSON (rig.json for the live sensors, the `rig` key of a session's
// session.json for a recording), readable and editable by hand:
//
//   {"sensors": [{"name": "a", "ip": "192.168.178.200",
//                 "pose": {"x": 0, "y": 0, "z": 1.1, "yaw": 0, "pitch": 0, "roll": 0},
//                 "time_offset_s": 0.0, "calibrated": "2026-10-20T12:00:00", "quality": {...}}]}
//
// Positions in m, angles in degrees (yaw about z, then pitch, then roll; see processing/src/fusion/pose.ts).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ValueError } from "./errors";

const SENSOR_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const POSE_KEYS = ["x", "y", "z", "yaw", "pitch", "roll"] as const;
const SENSOR_KEYS = ["pose", "time_offset_s", "calibrated", "quality"] as const;   // what a PUT may change

export type Pose = Record<(typeof POSE_KEYS)[number], number>;
export interface RigSensor { name: string; ip?: string; pose?: Pose; time_offset_s?: number; calibrated?: string; quality?: unknown; [k: string]: unknown }
export interface Rig { sensors: RigSensor[]; [k: string]: unknown }
export interface SensorSpec { name: string; ip: string }

export function checkName(name: unknown): string {
  if (typeof name !== "string" || !SENSOR_NAME_RE.test(name))
    throw new ValueError(`invalid sensor name ${JSON.stringify(name ?? null)} (letters, digits, _ and -, at most 32)`);
  return name;
}

/** --sensor NAME=IP */
export function parseSensorArg(arg: string): SensorSpec {
  const at = arg.indexOf("=");
  if (at < 0 || at === arg.length - 1) throw new ValueError(`--sensor ${JSON.stringify(arg)}: expected NAME=IP`);
  return { name: checkName(arg.slice(0, at)), ip: arg.slice(at + 1) };
}

export function loadRig(path: string | null): Rig {
  if (!path || !existsSync(path)) return { sensors: [] };
  const rig = JSON.parse(readFileSync(path, "utf8")) as Rig;
  if (!rig || typeof rig !== "object" || Array.isArray(rig) || !Array.isArray(rig.sensors ?? []))
    throw new ValueError(`${path}: expected {"sensors": [...]}`);
  rig.sensors ??= [];
  for (const s of rig.sensors) checkName(s.name);
  return rig;
}

/** write through a temporary file, so a crash never leaves half a file */
export function saveJson(path: string, obj: unknown): void {
  writeFileSync(path + ".tmp", JSON.stringify(obj, null, 2) + "\n");
  renameSync(path + ".tmp", path);
}

export function checkPose(pose: unknown): Pose {
  const p = pose as Record<string, unknown>;
  if (!p || typeof p !== "object" || Object.keys(p).sort().join() !== [...POSE_KEYS].sort().join())
    throw new ValueError(`a pose needs exactly ${POSE_KEYS.join(", ")}`);
  const out = {} as Pose;
  for (const k of POSE_KEYS) {
    const v = p[k];
    if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e4) throw new ValueError(`pose ${k}: expected a number`);
    out[k] = v;
  }
  return out;
}

/** the rig with `update`'s sensors applied by name (only the keys a PUT may change; others are kept as they are) */
export function mergeRig(rig: Rig, update: unknown): Rig {
  const sensors = new Map((rig.sensors ?? []).map(s => [s.name, { ...s }]));
  const items = (update as { sensors?: unknown })?.sensors;
  if (!Array.isArray(items)) throw new ValueError('expected {"sensors": [...]}');
  for (const u of items) {
    const name = checkName(u && typeof u === "object" ? (u as RigSensor).name : null);
    const s = sensors.get(name) ?? { name };
    sensors.set(name, s);
    for (const k of SENSOR_KEYS) if (k in u) (s as Record<string, unknown>)[k] = k === "pose" ? checkPose(u[k]) : u[k];
  }
  return { ...rig, sensors: [...sensors.values()] };
}

/** the entries of `names`, in that order (sensors without one get just their name) */
export function rigFor(rig: Rig, names: string[]): Rig {
  const byName = new Map((rig.sensors ?? []).map(s => [s.name, s]));
  return { sensors: names.map(n => byName.get(n) ?? { name: n }) };
}
