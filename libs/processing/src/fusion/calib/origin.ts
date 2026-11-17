// Which sensor is the world's origin. A calibration makes the first sensor's levelled frame the world (z up, origin on
// the floor below it, x its forward direction), but any placed sensor can be: the world is only moved, rigidly, so
// every sensor keeps its place relative to the others and nothing needs measuring again.
//
// The new world's "up" is the new origin's own: the floor as that sensor saw it (its FloorFit: tilt and height, which
// a calibration keeps per sensor). Without one (a rig stored before it was kept) the world keeps the old up and
// only turns and moves to the sensor's heading and place.
import { apply, compose, fromParams, invert, toParams, type Pose, type PoseParams } from "../pose";
import type { Region } from "./region";

/** a sensor's own floor: its tilt and its height above it (degrees, m), as the floor fit gives them */
export interface OwnFloor { pitch: number; roll: number; height: number }

/** a sensor's levelled frame in the world: its place and heading, on the floor (no tilt) */
export function levelledFrame(pose: Pose): Pose {
  const p = toParams(pose);
  return fromParams({ x: p.x, y: p.y, z: 0, yaw: p.yaw, pitch: 0, roll: 0 });
}

/** old world → new world, for the sensor at `pose` becoming the origin: it ends up at its own floor's level pose
 *  (x = y = yaw = 0) when `floor` is known, else keeps the tilt it has in the old world */
export function worldChange(pose: Pose, floor?: OwnFloor | null): Pose {
  if (!floor) return invert(levelledFrame(pose));
  const own = fromParams({ x: 0, y: 0, z: floor.height, yaw: 0, pitch: floor.pitch, roll: floor.roll });
  return compose(own, invert(pose));
}

/** the poses in the new world */
export function moveOrigin(poses: Pose[], origin: number, floor?: OwnFloor | null): Pose[] {
  const W = worldChange(poses[origin], floor);
  return poses.map(p => compose(W, p));
}

/** a region (world x, y pairs) in the new world */
export function moveRegion(region: Region, W: Pose): Region {
  return region.map(([x, y]) => { const p = apply(W, [x, y, 0]); return [p[0], p[1]] as [number, number]; });
}

export interface PlacedSensor { name: string; pose?: PoseParams; region?: Region; floor?: OwnFloor }

/** the rig entries that change when the world moves to sensor `name` (stored form: degrees, rounded as rigEntry does).
 *  Sensors without a pose are not placed in this world and stay as they are. Throws if `name` has no pose. */
export function moveRigOrigin(sensors: PlacedSensor[], name: string): { name: string; pose: PoseParams; region?: Region }[] {
  const placed = sensors.filter((s): s is PlacedSensor & { pose: PoseParams } => !!s.pose);
  const k = placed.findIndex(s => s.name === name);
  if (k < 0) throw new Error(`${name} has no pose in this rig: calibrate it first`);
  const poses = placed.map(s => fromParams(s.pose)), W = worldChange(poses[k], placed[k].floor), r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d + 0;
  return placed.map((s, i) => {
    const p = toParams(compose(W, poses[i]));
    return { name: s.name, pose: { x: r(p.x, 4), y: r(p.y, 4), z: r(p.z, 4), yaw: r(p.yaw, 3), pitch: r(p.pitch, 3), roll: r(p.roll, 3) },
             ...(s.region ? { region: moveRegion(s.region, W).map(([x, y]) => [r(x, 4), r(y, 4)] as [number, number]) } : {}) };
  });
}
