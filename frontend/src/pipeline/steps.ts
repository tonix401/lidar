// The processing pipeline, in order. Each step is a thin call into its stage's module; Processor runs them in
// three phases:
//  • ingest: once per new scan — intensity filter → layer calibration → motion detection (on the unfiltered
//    scan) → outlier rejection → temporal model → layer-calibration learning → objects → radial cells;
//  • refine: the spatial stages on the current temporal state → grid.out, also re-run after a settings
//    change — history filter → bilateral → moving-area smoothing → radial cells → planes → clean outlines
//    → walls drawn behind moving objects → metrics;
//  • learn: once per new scan, after refine, from the final ranges — remembered walls, flicker metric.
// A new stage: its module (StageDef, state, functions), a step here, and its entry in config/stages.ts.
import type { Config } from "../config/config";
import type { RemovedStat } from "../config/types";
import type { FrameMeta } from "../core/types";
import type { ObjectDetector } from "../objects/detector";
import { bilateral } from "./bilateral";
import { Cells } from "./cells";
import { dynSmooth } from "./dynsmooth";
import type { Grid } from "./grid";
import { historyFilter } from "./history";
import { intensityFilter, rssiHistogram } from "./intensity";
import { applyLayerBias, updateLayerBias } from "./layercal";
import { movingRoughness, type FlickerMeter } from "./metrics";
import { detectMotion } from "./motion";
import { rejectOutliers } from "./outlier";
import { dropMixed, frontMask, snapToWall } from "./outline";
import { flattenPlanes } from "./planes";
import { temporalUpdate } from "./temporal";
import { forgetWalls, updateWall, wallFill } from "./wall";

export type FrameStats = Record<RemovedStat, number> & {
  wallFill: number; ingestMs: number; refineMs: number;
  movRough: number; movFlicker: number;        // moving areas: roughness (mm), foreground flips per scan (0..1)
};

export const LAYERCAL_EVERY = 10;      // scans between calibration updates

/** what the steps may read and change: the Processor's long-lived state */
export interface StepContext {
  readonly cfg: Config;
  readonly meta: FrameMeta | null;
  readonly ts: number;                 // scan time (s)
  readonly stats: FrameStats;
  readonly objects: ObjectDetector | null;
  readonly flickerMeter: FlickerMeter | null;
  layerBias: Float32Array;
  rssiHist: Uint32Array<ArrayBufferLike>;
  cells: Cells | null;
  scans: number;                       // scans with layer-calibration learning on
  onLayerBias: ((bias: Float32Array) => void) | null;
  /** the object detector's empty-scene ranges, once learned */
  background(): Float32Array | null;
}

export interface Step {
  name: string;
  phase: "ingest" | "refine" | "learn";
  /** `scan`: a new scan (learning steps), not a re-run after a settings change */
  run(c: StepContext, g: Grid, scan: boolean): void;
}

export const PIPELINE: readonly Step[] = [
  // ingest (g.work is scratch until refine)
  { name: "intensity", phase: "ingest", run: (c, g) => {
    c.rssiHist = rssiHistogram(g.rawIn, g.rssi);
    c.stats.intensity = intensityFilter(g.rawIn, g.rssi, g.work, c.cfg.intensity);
  } },
  { name: "layercal", phase: "ingest", run: (c, g) => {
    if (c.layerBias.length !== g.L) c.layerBias = new Float32Array(g.L);
    if (c.cfg.layercal.on) applyLayerBias(g, g.work, c.layerBias);
  } },
  { name: "adaptive", phase: "ingest", run: (c, g) => { detectMotion(g, g.work, c.cfg); } },
  { name: "outlier", phase: "ingest", run: (c, g) => { c.stats.outliers = rejectOutliers(g, g.work, g.raw, c.cfg); } },   // relaxed inside moving areas
  { name: "temporal", phase: "ingest", run: (c, g) => { temporalUpdate(g, g.raw, c.cfg); } },
  { name: "layercal learning", phase: "ingest", run: (c, g) => {
    const lc = c.cfg.layercal;
    if (lc.on && lc.rate > 0 && ++c.scans % LAYERCAL_EVERY === 0 && updateLayerBias(g, g.temporal, c.layerBias, lc.rate)) c.onLayerBias?.(c.layerBias);
  } },
  { name: "objects", phase: "ingest", run: (c, g) => { c.objects!.update(g, g.raw, c.ts, c.meta!.step_deg, c.cfg); } },
  { name: "cells", phase: "ingest", run: (c, g) => {
    const cfg = c.cfg;
    if (!cfg.cells.on || !cfg.adaptive.on) { c.cells = null; return; }
    if (!c.cells?.fits(g.L, g.B, cfg.cells)) c.cells = new Cells(g.L, g.B, cfg.cells.colBeams, cfg.cells.colLayers);
    c.cells.update(g, g.raw, c.ts, cfg);
  } },

  // refine: g.temporal → g.hist → g.work → g.out
  { name: "history", phase: "refine", run: (c, g) => { c.stats.flicker = historyFilter(g, g.temporal, g.hist, c.cfg); } },
  { name: "spatial", phase: "refine", run: (c, g) => { bilateral(g, g.hist, g.work, c.cfg); } },
  { name: "dynamic", phase: "refine", run: (c, g) => {
    c.stats.veils = dynSmooth(g, g.hist, g.work, c.background(), c.meta?.step_deg ?? 0.13, c.cfg);
  } },
  { name: "cells", phase: "refine", run: (c, g) => {
    c.stats.spikes = c.cells && c.cfg.cells.on ? c.cells.apply(g, g.raw, g.work, c.cfg) : 0;
  } },
  { name: "planes", phase: "refine", run: (c, g) => { flattenPlanes(g, g.work, g.out, c.cfg); } },
  { name: "walls off", phase: "refine", run: (c, g) => { if (!c.cfg.walls.on && g.wallN.some(n => n > 0)) forgetWalls(g); } },
  { name: "outline", phase: "refine", run: (c, g, scan) => {
    c.stats.mixed = 0;
    if (!c.cfg.outline.on) { g.front.fill(0); return; }
    snapToWall(g, g.out, c.cfg, scan);
    frontMask(g, g.out, c.background(), c.cfg, g.front);
    c.stats.mixed = dropMixed(g, g.out, g.front, c.cfg);
  } },
  { name: "wall fill", phase: "refine", run: (c, g) => { c.stats.wallFill = wallFill(g, g.out, c.background(), c.cfg, g.fill); } },
  { name: "roughness", phase: "refine", run: (c, g) => { c.stats.movRough = movingRoughness(g, g.out, c.cfg); } },

  // learn
  { name: "walls", phase: "learn", run: (c, g) => { if (c.cfg.walls.on) updateWall(g, g.out, c.background(), c.cfg); } },
  { name: "flicker", phase: "learn", run: (c, g) => {
    c.stats.movFlicker = c.flickerMeter!.update(g, g.out, c.objects!.bgModel, c.cfg);
  } },
];
