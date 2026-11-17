// Which sensor is the main one: the world is the floor below it (z up, origin on the floor under it, x its forward
// direction). Every sensor is level, so moving the world to another sensor is a turn about z and a shift along the
// floor: heights don't change, and the floor stays at z = 0. The world is only moved, rigidly, so every sensor
// keeps its place relative to the others and nothing needs measuring again.
import { apply, compose, fromParams, invert, toParams, type Pose, type PoseParams } from "../pose";
import type { Region } from "./region";

/** old world → new world, for the sensor at `pose` becoming the main one: the inverse of its place on the floor */
export function worldChange(pose: Pose): Pose {
  const p = toParams(pose);
  return invert(fromParams({ ...p, z: 0 }));
}

/** the poses in the new world */
export function moveOrigin(poses: Pose[], origin: number): Pose[] {
  const W = worldChange(poses[origin]);
  return poses.map(p => compose(W, p));
}

/** a region (world x, y pairs) in the new world */
export function moveRegion(region: Region, W: Pose): Region {
  return region.map(([x, y]) => { const p = apply(W, [x, y, 0]); return [p[0], p[1]] as [number, number]; });
}

export interface PlacedSensor { name: string; pose?: PoseParams; region?: Region }

/** the rig entries that change when the world moves to sensor `name` (stored form: degrees, rounded as rigEntry does).
 *  Sensors without a pose are not placed in this world and stay as they are. Throws if `name` has no pose. */
export function moveRigOrigin(sensors: PlacedSensor[], name: string): { name: string; pose: PoseParams; region?: Region }[] {
  const placed = sensors.filter((s): s is PlacedSensor & { pose: PoseParams } => !!s.pose);
  const k = placed.findIndex(s => s.name === name);
  if (k < 0) throw new Error(`${name} has no pose in this rig: calibrate it first`);
  const poses = placed.map(s => fromParams(s.pose)), W = worldChange(poses[k]), r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d + 0;
  return placed.map((s, i) => {
    const p = toParams(compose(W, poses[i]));
    return { name: s.name, pose: { x: r(p.x, 4), y: r(p.y, 4), z: r(p.z, 4), yaw: r(p.yaw, 3) },
             ...(s.region ? { region: moveRegion(s.region, W).map(([x, y]) => [r(x, 4), r(y, 4)] as [number, number]) } : {}) };
  });
}
