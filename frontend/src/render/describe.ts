// The hover tooltip for one beam in the 2D views: where it points, its ranges and what the pipeline made of it.
import type { Config } from "../config/config";
import { popcount } from "../core/math";
import type { FrameMeta, Mount } from "../core/types";
import type { ObjectDetector } from "../objects/detector";
import { trackLabel } from "../objects/tracker";
import type { Grid } from "../pipeline/grid";
import { historyMask } from "../pipeline/history";
import type { Geometry } from "./geometry";

export interface BeamContext {
  grid: Grid; meta: FrameMeta; geo: Geometry | null; objects: ObjectDetector | null;
  cfg: Config; layerBias: Float32Array; mount: Mount;
}

export function describeBeam(c: BeamContext, i: number): string {
  const g = c.grid, meta = c.meta, objects = c.objects;
  const l = Math.floor(i / g.B), b = i % g.B;
  const valid = popcount(g.validBits[i] & historyMask(g.frames)) / Math.max(1, g.frames);
  const t = objects?.tracker.byId(objects.cell[i]);
  const bg = objects?.bgModel.bg[i] ?? 0;
  const status = (c.geo?.vis[i] ? "" : g.rawIn[i] > 0 ? "\nremoved by filters" : "\nno return") +
    (t?.confirmed ? `\nobject ${trackLabel(t)}` : "") + (bg > 0 ? `\nempty-scene range ${bg.toFixed(2)} m` : "");
  return `layer ${l}  ·  beam ${b}\n` +
    `azimuth ${(meta.start_azimuth_deg + b * meta.step_deg).toFixed(2)}°  elevation ${((c.mount === "upsidedown" ? -1 : 1) * g.elev[i]).toFixed(2)}°\n` +
    `distance ${g.out[i] > 0 ? g.out[i].toFixed(3) + " m" : "–"}  (raw ${g.rawIn[i] > 0 ? g.rawIn[i].toFixed(3) + " m" : "–"})\n` +
    `RSSI ${g.rssi[i]}  ·  noise σ ${(Math.sqrt(g.noiseVar[i]) * 1000).toFixed(0)} mm  ·  layer offset ${c.cfg.layercal.on ? (c.layerBias[l] * 1000).toFixed(1) + " mm" : "off"}\n` +
    `valid ${(valid * 100).toFixed(0)} %  ·  jump rate ${(g.jumpRate[i] * 100).toFixed(0)} %  ·  conf ${g.conf[i].toFixed(2)}` + status;
}
