// Which sensor is the world's origin. A calibration makes the first sensor's levelled frame the world (z up, origin on
// the floor below it, x its forward direction), but any placed sensor can be: the world is only moved, rigidly,
// so every sensor keeps its place relative to the others and nothing needs measuring again.
import { DEG } from "../../core/math";
import { compose, fromParams, invert, toParams, type Pose, type PoseParams } from "../pose";
import type { Region } from "./region";

/** a sensor's levelled frame in the world: its place and heading, on the floor (no tilt) */
export function levelledFrame(pose: Pose): Pose {
  const p = toParams(pose);
  return fromParams({ x: p.x, y: p.y, z: 0, yaw: p.yaw, pitch: 0, roll: 0 });
}

/** the poses with the world moved to `poses[origin]`'s levelled frame; that sensor then stands at x = y = yaw = 0 */
export function moveOrigin(poses: Pose[], origin: number): Pose[] {
  const inv = invert(levelledFrame(poses[origin]));
  return poses.map(p => compose(inv, p));
}

/** a region (world x, y pairs) followed into the moved world: `from` is the origin sensor's pose in the old world */
export function moveRegion(region: Region, from: Pose): Region {
  const p = toParams(from), a = -p.yaw * DEG, c = Math.cos(a), s = Math.sin(a);
  return region.map(([x, y]) => [c * (x - p.x) - s * (y - p.y), s * (x - p.x) + c * (y - p.y)]);
}

export interface PlacedSensor { name: string; pose?: PoseParams; region?: Region }

/** the rig entries that change when the world moves to sensor `name` (stored form: degrees, rounded as rigEntry does).
 *  Sensors without a pose are not placed in this world and stay as they are. Throws if `name` has no pose. */
export function moveRigOrigin(sensors: PlacedSensor[], name: string): { name: string; pose: PoseParams; region?: Region }[] {
  const placed = sensors.filter((s): s is PlacedSensor & { pose: PoseParams } => !!s.pose);
  const k = placed.findIndex(s => s.name === name);
  if (k < 0) throw new Error(`${name} has no pose in this rig: calibrate it first`);
  const poses = placed.map(s => fromParams(s.pose)), moved = moveOrigin(poses, k), r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d + 0;
  return placed.map((s, i) => {
    const p = toParams(moved[i]);
    return { name: s.name, pose: { x: r(p.x, 4), y: r(p.y, 4), z: r(p.z, 4), yaw: r(p.yaw, 3), pitch: r(p.pitch, 3), roll: r(p.roll, 3) },
             ...(s.region ? { region: moveRegion(s.region, poses[k]).map(([x, y]) => [r(x, 4), r(y, 4)] as [number, number]) } : {}) };
  });
}
