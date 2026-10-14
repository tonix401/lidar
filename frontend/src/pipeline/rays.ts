import { DEG } from "../core/math";
import type { Mount } from "../core/types";
import type { Grid } from "./grid";

/** Unit ray per beam in the world frame (x forward, y left, z up). Upright: negative elevation points
 *  down. Upside down (sensor on its head): only the vertical flips — with the device's UpsideDown
 *  parameter set, the sensor already reports azimuth in world left/right, so y must NOT change sign
 *  (doing so mirrored the scene). Same convention as SICK's own viewer. */
export function updateRays(g: Grid, az0Deg: number, stepDeg: number, mount: Mount): void {
  const zs = mount === "upsidedown" ? -1 : 1;
  for (let l = 0; l < g.L; l++) for (let b = 0; b < g.B; b++) {
    const i = l * g.B + b, az = (az0Deg + b * stepDeg) * DEG, el = g.elev[i] * DEG;
    g.rayX[i] = Math.cos(az) * Math.cos(el); g.rayY[i] = Math.sin(az) * Math.cos(el); g.rayZ[i] = zs * Math.sin(el);
  }
  g.raysReady = true;
}
