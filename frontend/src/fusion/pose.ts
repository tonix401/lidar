// Rigid poses of the sensors in the world frame: world point = R · sensor point + t. The sensor frame is
// the one the pipeline already uses (x forward, y left, z up, mount applied, see pipeline/rays.ts); the
// world frame is z up with the floor at z = 0 (docs/multisensor.md).
import { DEG } from "../core/math";

export interface Pose { R: number[]; t: number[] }        // R: 3×3 row-major, t: x y z (m)

/** the human-readable form: position (m) and Z-Y-X Euler angles (degrees): yaw about z, then pitch
 *  about the new y, then roll about the new x, so R = Rz(yaw) · Ry(pitch) · Rx(roll) */
export interface PoseParams { x: number; y: number; z: number; yaw: number; pitch: number; roll: number }

export const IDENTITY: Pose = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

export function fromParams(p: PoseParams): Pose {
  const [cy, sy] = [Math.cos(p.yaw * DEG), Math.sin(p.yaw * DEG)];
  const [cp, sp] = [Math.cos(p.pitch * DEG), Math.sin(p.pitch * DEG)];
  const [cr, sr] = [Math.cos(p.roll * DEG), Math.sin(p.roll * DEG)];
  return { R: [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr,
               sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr,
               -sp, cp * sr, cp * cr], t: [p.x, p.y, p.z] };
}

export function toParams({ R, t }: Pose): PoseParams {
  const pitch = Math.asin(Math.max(-1, Math.min(1, -R[6])));
  return { x: t[0], y: t[1], z: t[2], yaw: Math.atan2(R[3], R[0]) / DEG, pitch: pitch / DEG, roll: Math.atan2(R[7], R[8]) / DEG };
}

/** a ∘ b: first b, then a */
export function compose(a: Pose, b: Pose): Pose {
  const R = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    R[3 * i + j] = a.R[3 * i] * b.R[j] + a.R[3 * i + 1] * b.R[3 + j] + a.R[3 * i + 2] * b.R[6 + j];
  return { R, t: apply(a, b.t) };
}

export function invert({ R, t }: Pose): Pose {
  const Rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  return { R: Rt, t: [-(Rt[0] * t[0] + Rt[1] * t[1] + Rt[2] * t[2]), -(Rt[3] * t[0] + Rt[4] * t[1] + Rt[5] * t[2]),
                      -(Rt[6] * t[0] + Rt[7] * t[1] + Rt[8] * t[2])] };
}

export function apply({ R, t }: Pose, p: ArrayLike<number>): number[] {
  return [R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0], R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1],
          R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2]];
}

export function rotate({ R }: Pose, v: ArrayLike<number>): number[] {
  return [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
}

/** transform n xyz points in place (or into `out`) */
export function applyAll({ R, t }: Pose, p: Float32Array, n = p.length / 3, out: Float32Array = p): Float32Array {
  for (let i = 0; i < 3 * n; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = R[0] * x + R[1] * y + R[2] * z + t[0];
    out[i + 1] = R[3] * x + R[4] * y + R[5] * z + t[1];
    out[i + 2] = R[6] * x + R[7] * y + R[8] * z + t[2];
  }
  return out;
}

/** small rotation (rx, ry, rz in rad, a rotation vector) as a pose: Rodrigues' formula */
export function fromRotationVector(rx: number, ry: number, rz: number, t: number[] = [0, 0, 0]): Pose {
  const th = Math.hypot(rx, ry, rz);
  if (th < 1e-12) return { R: [1, -rz, ry, rz, 1, -rx, -ry, rx, 1], t };
  const [x, y, z] = [rx / th, ry / th, rz / th], c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return { R: [c + x * x * C, x * y * C - z * s, x * z * C + y * s,
               y * x * C + z * s, c + y * y * C, y * z * C - x * s,
               z * x * C - y * s, z * y * C + x * s, c + z * z * C], t };
}

/** how far apart two poses are: translation (m) and rotation angle (degrees) */
export function poseError(a: Pose, b: Pose): { dist: number; angle: number } {
  const d = compose(invert(a), b);
  const tr = d.R[0] + d.R[4] + d.R[8];
  return { dist: Math.hypot(a.t[0] - b.t[0], a.t[1] - b.t[1], a.t[2] - b.t[2]),
           angle: Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) / DEG };
}

/** column-major 4×4 for three.js Matrix4.fromArray */
export function toMatrix4({ R, t }: Pose): number[] {
  return [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, t[0], t[1], t[2], 1];
}
