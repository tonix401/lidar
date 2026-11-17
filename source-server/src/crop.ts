// Cutting a sensor's beams outside its rig entry's region (a polygon in the world, from above; rig.ts) from the scans
// the source server sends. The beams are set to "no return", as the sensor reports a miss, so everything downstream
// (the pipeline, the viewers, tracking) never sees what lies outside. Recordings keep the raw scans, and so does
// the calibration, which needs the whole scene to place the region on.
import { DEG } from "@mrs6000/processing/core/math";
import { pointInPolygon, type Region } from "@mrs6000/processing/fusion/calib/region";
import { fromParams, type Pose } from "@mrs6000/processing/fusion/pose";
import { mountZSign } from "@mrs6000/processing/pipeline/rays";
import type { MountSetting } from "@mrs6000/server-common/sensor/core";
import type { Frame, Header } from "@mrs6000/wire/frame";
import { DIST_UNIT_MM } from "@mrs6000/wire/frame";
import type { RigSensor } from "./rig";

interface Rays { key: string; x: Float32Array; y: Float32Array; z: Float32Array }

export class Crop {
  private rays = new WeakMap<Header, Rays>();
  private poses = new Map<string, { key: string; pose: Pose }>();

  /** `f` without the beams outside `entry.region` (the same frame when there is nothing to cut) */
  apply<F extends Frame>(sensor: string, f: F, hdr: Header, entry: RigSensor | undefined, mount: MountSetting): F {
    const region = entry?.region as Region | undefined;
    if (!region || !entry?.pose) return f;
    const key = JSON.stringify(entry.pose);
    let p = this.poses.get(sensor);
    if (p?.key !== key) this.poses.set(sensor, p = { key, pose: fromParams(entry.pose) });
    const { R, t } = p.pose, { x, y, z } = this.raysOf(hdr, mount);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [a, b] of region) { x0 = Math.min(x0, a); x1 = Math.max(x1, a); y0 = Math.min(y0, b); y1 = Math.max(y1, b); }
    const d = Uint16Array.from(f.d), r = Uint16Array.from(f.r), u = DIST_UNIT_MM / 1000;
    for (let i = 0; i < d.length; i++) {
      if (!d[i]) continue;
      const m = d[i] * u, px = x[i] * m, py = y[i] * m, pz = z[i] * m;
      const wx = R[0] * px + R[1] * py + R[2] * pz + t[0], wy = R[3] * px + R[4] * py + R[5] * pz + t[1];
      if (wx < x0 || wx > x1 || wy < y0 || wy > y1 || !pointInPolygon(wx, wy, region)) { d[i] = 0; r[i] = 0; }
    }
    return { ...f, d, r };
  }

  /** unit rays of a layout in the sensor frame, as the pipeline computes them (pipeline/rays.ts) */
  private raysOf(hdr: Header, mount: MountSetting): Rays {
    const zs = mountZSign(mount !== "auto" ? mount : hdr.upside_down ? "upsidedown" : "upright"), key = `${hdr.start_azimuth_deg} ${hdr.step_deg} ${zs}`;
    let r = this.rays.get(hdr);
    if (r?.key === key) return r;
    const N = hdr.layers * hdr.beams;
    r = { key, x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N) };
    for (let l = 0; l < hdr.layers; l++) for (let b = 0; b < hdr.beams; b++) {
      const i = l * hdr.beams + b, az = (hdr.start_azimuth_deg + b * hdr.step_deg) * DEG, el = hdr.elev[i] * DEG;
      r.x[i] = Math.cos(az) * Math.cos(el); r.y[i] = Math.sin(az) * Math.cos(el); r.z[i] = zs * Math.sin(el);
    }
    this.rays.set(hdr, r);
    return r;
  }
}
