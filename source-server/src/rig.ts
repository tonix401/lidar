// The rig: which sensors there are and where they are (rig types: libs/wire/src/rig.ts). The live rig lives in the
// registry (store.ts), a recording's in its files' headers (recording/session.ts); calibration (calibration.ts) and PUT /api/rig change them.
import { ValueError } from "@mrs6000/server-common/errors";
import { checkName } from "@mrs6000/server-common/names";
import { checkRegion } from "@mrs6000/processing/fusion/calib/region";
import { POSE_KEYS, type Pose, type Rig, type RigSensor } from "@mrs6000/wire/rig";

export { rigFor, type Rig, type RigSensor } from "@mrs6000/wire/rig";

const SENSOR_KEYS = ["pose", "time_offset_s", "calibrated", "quality", "region"] as const;   // what a PUT may change
const LEVEL = 0.05;                                       // degrees: a stored pitch or roll up to this counts as level

export interface SensorSpec { name: string; ip: string }

/** --sensor NAME=IP */
export function parseSensorArg(arg: string): SensorSpec {
  const at = arg.indexOf("=");
  if (at < 0 || at === arg.length - 1) throw new ValueError(`--sensor ${JSON.stringify(arg)}: expected NAME=IP`);
  return { name: checkName(arg.slice(0, at)), ip: arg.slice(at + 1) };
}

/** a pose as stored: x, y, z, yaw. Every sensor is level, so a pitch or roll (from before) is accepted only when it is 0. */
export function checkPose(pose: unknown): Pose {
  const p = pose as Record<string, unknown>, keys = p && typeof p === "object" ? Object.keys(p).filter(k => k !== "pitch" && k !== "roll") : [];
  if (!p || typeof p !== "object" || keys.sort().join() !== [...POSE_KEYS].sort().join())
    throw new ValueError(`a pose needs exactly ${POSE_KEYS.join(", ")}`);
  for (const k of ["pitch", "roll"]) if (k in p && !(typeof p[k] === "number" && Math.abs(p[k] as number) <= LEVEL))
    throw new ValueError(`pose ${k}: every sensor is mounted level, so it must be 0`);
  const out = {} as Pose;
  for (const k of POSE_KEYS) {
    const v = p[k];
    if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e4) throw new ValueError(`pose ${k}: expected a number`);
    out[k] = v;
  }
  return out;
}

/** a stored entry with its pose made level: pitch and roll dropped (a sensor stored as tilted is reported in `tilted`) */
export function levelEntry<T extends RigSensor>(s: T, tilted: string[] = []): T {
  const p = s.pose as Record<string, number> | undefined;
  if (!p || !("pitch" in p || "roll" in p)) return s;
  const { pitch = 0, roll = 0, ...rest } = p;
  if (Math.abs(pitch) > LEVEL || Math.abs(roll) > LEVEL) tilted.push(s.name);
  return { ...s, pose: rest as Pose };
}

function checkRegionOf(region: unknown) {
  try { return checkRegion(region); } catch (e) { throw new ValueError(`region: ${e instanceof Error ? e.message : e}`); }
}

/** the rig with `update`'s sensors applied by name (only the keys a PUT may change; others are kept as they are).
 *  `withMain`: also which sensor is the main one (only together with poses re-expressed for it: hub.ts setOrigin) */
export function mergeRig(rig: Rig, update: unknown, withMain = false): Rig {
  const sensors = new Map((rig.sensors ?? []).map(s => [s.name, { ...s }]));
  const items = (update as { sensors?: unknown })?.sensors;
  if (!Array.isArray(items)) throw new ValueError('expected {"sensors": [...]}');
  for (const u of items) {
    const name = checkName(u && typeof u === "object" ? (u as RigSensor).name : null);
    const s = sensors.get(name) ?? { name };
    sensors.set(name, s);
    if (withMain && u.main === true) for (const x of sensors.values()) delete x.main;
    if (withMain && u.main === true) s.main = true;
    for (const k of SENSOR_KEYS) if (k in u) {
      if (k === "region") { if (u[k] === null) delete s.region; else s.region = checkRegionOf(u[k]); }   // null: no region
      else (s as Record<string, unknown>)[k] = k === "pose" ? checkPose(u[k]) : u[k];
    }
  }
  return { ...rig, sensors: [...sensors.values()] };
}
