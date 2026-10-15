// What a pipeline stage declares about its settings: the panel section (title, help, parameters), its
// defaults, and how auto mode and the presets treat it. Each stage module exports one StageDef;
// config/stages.ts lists them in panel order.
import type { Config, StageKey } from "./stages";

/** 3D view, 2D map (top), range image */
export type ViewMode = "3d" | "top" | "image";

export interface Param {
  k: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  pct?: boolean;                       // shown as % of range
  fmt?: (v: number) => string;
  edit?: { scale: number; unit: string };   // typed value = stored × scale (default: as stored, in `unit`)
}

/** FrameStats counters of returns a stage removed (shown under Statistics → Removed by filters) */
export type RemovedStat = "intensity" | "outliers" | "flicker" | "veils" | "spikes" | "mixed";

export interface StageDef<K extends StageKey = StageKey> {
  key: K;
  title: string;
  toggle: boolean;
  help: string;
  note?: string;
  extra?: "histogram" | "layerbias";
  host?: "objects" | "display";        // rendered with the object detection / display settings instead of the stage list
  views?: ViewMode[];                  // only shown in these views (default: all)
  params: Param[];
  defaults: Config[K];                 // for preset stages: the "medium" preset
  /** auto mode: "user" = the stage stays the user's (content choices, experiments); "toggle" = its on/off
   *  stays the user's, the parameters are tuned; "tuned" = set automatically */
  auto: "user" | "toggle" | "tuned";
  /** part of the smoothing presets (off / light / medium / strong) */
  preset: boolean;
  /** not a preset stage, but changes the ranges: the "off" preset switches it off, the others switch it
   *  back on if it is on by default */
  rawOff?: true;
  removed?: { label: string; stat: RemovedStat };
}
