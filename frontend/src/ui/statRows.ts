// The Statistics box: every live number, grouped (rendered by ui/statsPanel.ts). Pure: from a snapshot of
// the pipeline's state to rows.
import type { NoiseEstimate } from "../config/auto";
import { STAGES, type Config, type ViewMode } from "../config/config";
import type { ObjectDetector } from "../objects/detector";
import type { Track } from "../objects/tracker";
import type { FrameStats } from "../pipeline/processor";
import { drawParts, type DrawMode } from "../render/scene3d";
import type { StatRow } from "./statsPanel";

export const STAT_GROUPS = ["Timing", "Scene", "Removed by filters", "Moving areas (people)", "Objects"] as const;

export interface StatInputs {
  stats: FrameStats;
  cfg: Config;
  /** auto mode's noise estimate (null in manual mode or while learning) */
  estimate: NoiseEstimate | null;
  objects: ObjectDetector | null;
  tracks: Track[];                     // the objects shown
  view: ViewMode;
  draw: DrawMode;
  rendersPerSec: number;
  triangles: number;
}

export function statRows(s: StatInputs): Record<(typeof STAT_GROUPS)[number], StatRow[]> {
  const st = s.stats, c = s.cfg, objects = s.objects, est = s.estimate;
  const n = (v: number) => v.toLocaleString();
  const timing: StatRow[] = [["Processing", (st.ingestMs + st.refineMs).toFixed(0) + " ms", "filters, smoothing and objects for one scan"]];
  if (s.view === "3d") timing.push(["Renders / s", isNaN(s.rendersPerSec) ? "–" : String(s.rendersPerSec), "3D renders on demand: ≈ scan rate with a still camera"]);
  if (s.view === "3d" && drawParts(s.draw).surface) timing.push(["Triangles", n(s.triangles)]);
  const scene: StatRow[] = est ? [
    ["Noise floor", `${Math.round(est.noise * 1000)} mm`, `median noise σ of ${n(est.samples)} steady beams; auto mode derives its tolerances from it (change gate 3σ)`],
    ["Moving beams", `${(100 * est.movingShare).toFixed(1)} %`]] : [];
  const removed = STAGES.filter(st => st.removed && (c[st.key] as { on?: boolean }).on)
    .map((stage): StatRow => [stage.removed!.label, n(st[stage.removed!.stat])]);
  const moving: StatRow[] = isNaN(st.movRough) ? [] : [
    ["Roughness", st.movRough.toFixed(1) + " mm", "median deviation of a moving beam from its same-surface neighbours; lower is cleaner"],
    ...(isNaN(st.movFlicker) ? [] : [["Flicker", (st.movFlicker * 100).toFixed(0) + " %", "share of moving beams that switched between object and background since the last scan; lower is cleaner"] as StatRow])];
  const people = s.tracks.filter(t => t.cls === "person").length;
  const obj: StatRow[] = c.objects.on && objects?.bgModel.ready ? [
    ["Objects", `${s.tracks.length} (${people} ${people === 1 ? "person" : "people"})`],
    ["Foreground beams", n(objects.foregroundCount), "returns clearly in front of the learned empty scene"],
    ["Detection time", objects.lastMs.toFixed(1) + " ms"]] : [];
  return { "Timing": timing, "Scene": scene, "Removed by filters": removed, "Moving areas (people)": moving, "Objects": obj };
}
