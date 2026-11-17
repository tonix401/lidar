// The rig: which sensors there are and where they are (rig types: libs/wire/src/rig.ts). The live rig lives in the
// registry (store.ts), a recording's in its files' headers (recording/session.ts); calibration (calibration.ts) and PUT /api/rig change them.
import { ValueError } from "@mrs6000/server-common/errors";
import { checkName } from "@mrs6000/server-common/names";
import { checkRegion } from "@mrs6000/processing/fusion/calib/region";
import { POSE_KEYS, type Pose, type Rig, type RigSensor } from "@mrs6000/wire/rig";

export { rigFor, type Rig, type RigSensor } from "@mrs6000/wire/rig";

const SENSOR_KEYS = ["pose", "time_offset_s", "calibrated", "quality", "region", "floor"] as const;   // what a PUT may change

export interface SensorSpec { name: string; ip: string }

/** --sensor NAME=IP */
export function parseSensorArg(arg: string): SensorSpec {
  const at = arg.indexOf("=");
  if (at < 0 || at === arg.length - 1) throw new ValueError(`--sensor ${JSON.stringify(arg)}: expected NAME=IP`);
  return { name: checkName(arg.slice(0, at)), ip: arg.slice(at + 1) };
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

function checkFloor(f: unknown) {
  const o = f as Record<string, unknown>;
  if (!o || typeof o !== "object" || Object.keys(o).sort().join() !== "height,pitch,roll") throw new ValueError("floor needs exactly pitch, roll, height");
  for (const k of ["pitch", "roll", "height"]) if (typeof o[k] !== "number" || !Number.isFinite(o[k] as number) || Math.abs(o[k] as number) > 100) throw new ValueError(`floor ${k}: expected a number`);
  return { pitch: o.pitch as number, roll: o.roll as number, height: o.height as number };
}

function checkRegionOf(region: unknown) {
  try { return checkRegion(region); } catch (e) { throw new ValueError(`region: ${e instanceof Error ? e.message : e}`); }
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
    for (const k of SENSOR_KEYS) if (k in u) {
      if (k === "floor") { if (u[k] === null) delete s.floor; else s.floor = checkFloor(u[k]); }
      else if (k === "region") { if (u[k] === null) delete s.region; else s.region = checkRegionOf(u[k]); }   // null: no region
      else (s as Record<string, unknown>)[k] = k === "pose" ? checkPose(u[k]) : u[k];
    }
  }
  return { ...rig, sensors: [...sensors.values()] };
}
