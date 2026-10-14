// Every tunable of the processing pipeline. Stage controls in the panel are generated from STAGES.
import { DEG } from "../core/math";

export interface Config {
  intensity: { on: boolean; min: number; max: number };
  layercal: { on: boolean; rate: number };
  adaptive: { on: boolean; minCluster: number; growBeams: number; hold: number; dynWindow: number; dynSpatial: number };
  outlier: { on: boolean; win: number; need: number; abs: number; rel: number };
  temporal: { on: boolean; window: number; k: number; minGate: number; confirm: number; noiseFloor: number; hold: number };
  history: { on: boolean; minValid: number; maxJump: number; weight: number };
  spatial: { on: boolean; wb: number; wl: number; srAbs: number; srRel: number; srNoise: number };
  planes: { on: boolean; wb: number; wl: number; planarity: number; minPts: number; minCos: number; tolAbs: number; tolRel: number; noiseFlat: number };
  mesh: { jump: number; jumpRel: number };
  objects: { on: boolean; scope: number; learn: number; minDiff: number; theta: number; margin: number; minPoints: number; mergeDist: number; gate: number; coast: number };
}
export type StageKey = keyof Config;

export interface Param {
  k: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  pct?: boolean;                       // shown as % of range
  fmt?: (v: number) => string;
}
export interface Stage {
  key: StageKey;
  title: string;
  toggle: boolean;
  help: string;
  note?: string;
  preset?: false;                      // not part of the smoothing presets
  extra?: "histogram" | "layerbias";
  host?: "objects";                    // rendered in the Objects panel section instead of Surface
  params: Param[];
}

export const STAGES: Stage[] = [
  { key: "intensity", title: "Intensity filter", toggle: true, extra: "histogram", preset: false,
    help: "Drops returns whose RSSI lies outside the range, before any smoothing (weak returns are often noise; very strong ones are reflectors).",
    params: [
      { k: "min", label: "Min. RSSI", min: 0, max: 400, step: 1 },
      { k: "max", label: "Max. RSSI", min: 0, max: 400, step: 1 } ] },
  { key: "layercal", title: "Layer calibration", toggle: true, extra: "layerbias", preset: false,
    help: "Each of the 24 layers has its own constant distance offset (up to a few cm), which shows up as horizontal " +
          "waves on flat walls. The offsets are learned live: each layer's median deviation from planes fitted through " +
          "its neighbouring layers. Mean, bottom-to-top trend and slow bow are pinned to zero (unmeasurable " +
          "from plane fits, they would otherwise drift into tilted or bulging walls), so scale and verticality are untouched.",
    params: [
      { k: "rate", label: "Learning rate", min: 0, max: 1, step: 0.05, fmt: v => v ? Math.round(v * 100) + " % per update" : "frozen" } ] },
  { key: "adaptive", title: "Adaptive per area", toggle: true, preset: false,
    help: "Detects moving areas (clusters of beams whose new value breaks their own history) and processes them " +
          "lightly: no long averaging or confirmation delay, no flicker removal, little spatial smoothing, no plane " +
          "flattening. Static areas keep the full settings below. Colour by 'Area class' to see the result.",
    params: [
      { k: "minCluster", label: "Min. moving cluster", min: 1, max: 60, step: 1, unit: " beams" },
      { k: "growBeams", label: "Grow into object", min: 0, max: 30, step: 1, unit: " steps" },
      { k: "hold", label: "Stay 'moving' after last change", min: 1, max: 50, step: 1, fmt: v => `${v} scans (${(v / 10).toFixed(1)} s)` },
      { k: "dynWindow", label: "Averaging in moving areas", min: 1, max: 5, step: 1, unit: " scans" },
      { k: "dynSpatial", label: "Spatial window in moving areas", min: 0, max: 6, step: 1, unit: " beams" } ] },
  { key: "outlier", title: "Outlier filter", toggle: true, note: "Applies to new scans.",
    help: "Drops returns without enough neighbours at a similar distance in the same layer.",
    params: [
      { k: "win", label: "Neighbour window", min: 1, max: 8, step: 1, unit: " beams" },
      { k: "need", label: "Required neighbours", min: 1, max: 6, step: 1 },
      { k: "abs", label: "Distance tolerance", min: 0.02, max: 0.5, step: 0.01, unit: " m" },
      { k: "rel", label: "Tolerance growth", min: 0, max: 0.1, step: 0.005, pct: true } ] },
  { key: "temporal", title: "Temporal smoothing", toggle: true, note: "Applies to new scans.",
    help: "Each beam averages its own history (Kalman-style): the window grows while the beam is still, " +
          "its noise σ is learned, a change beyond k·σ must be confirmed by following scans before the beam " +
          "switches (single spikes are ignored, real motion is followed).",
    params: [
      { k: "window", label: "Max. averaging window", min: 1, max: 60, step: 1, unit: " scans" },
      { k: "k", label: "Change gate", min: 1.5, max: 8, step: 0.5, fmt: v => v.toFixed(1) + " σ" },
      { k: "minGate", label: "Min. gate", min: 0.03, max: 0.5, step: 0.01, unit: " m" },
      { k: "confirm", label: "Confirm change after", min: 1, max: 5, step: 1, unit: " scans" },
      { k: "noiseFloor", label: "Noise floor σ", min: 0.005, max: 0.1, step: 0.001, fmt: v => Math.round(v * 1000) + " mm" },
      { k: "hold", label: "Hold through dropouts", min: 0, max: 10, step: 1, unit: " scans" } ] },
  { key: "history", title: "History filter", toggle: true,
    help: "Uses each beam's last 32 scans: drops beams that flicker (rarely valid or often jumping — mixed pixels " +
          "at edges, dust, reflections) and lets stable beams count more in spatial smoothing and plane fits.",
    params: [
      { k: "minValid", label: "Min. valid in history", min: 0, max: 1, step: 0.05, fmt: v => Math.round(v * 100) + " %" },
      { k: "maxJump", label: "Max. jump rate", min: 0.05, max: 1, step: 0.05, fmt: v => Math.round(v * 100) + " %" },
      { k: "weight", label: "Confidence weighting", min: 0, max: 3, step: 0.25, fmt: v => v ? "×" + v.toFixed(2) : "off" } ] },
  { key: "spatial", title: "Spatial smoothing", toggle: true,
    help: "Edge-preserving bilateral filter on the range image.",
    params: [
      { k: "wb", label: "Window along layer", min: 1, max: 12, step: 1, unit: " beams" },
      { k: "wl", label: "Window across layers", min: 0, max: 2, step: 1, unit: " layers" },
      { k: "srAbs", label: "Edge sensitivity σ", min: 0.01, max: 0.3, step: 0.005, unit: " m" },
      { k: "srRel", label: "σ growth", min: 0, max: 0.05, step: 0.001, pct: true },
      { k: "srNoise", label: "σ from beam noise", min: 0, max: 5, step: 0.5, fmt: v => v ? `≥ ${v}× beam σ` : "off" } ] },
  { key: "planes", title: "Flatten planes", toggle: true,
    help: "Fits a plane around each point (PCA) and moves the point along its beam onto it.",
    params: [
      { k: "wb", label: "Window along layer", min: 1, max: 12, step: 1, unit: " beams" },
      { k: "wl", label: "Window across layers", min: 0, max: 2, step: 1, unit: " layers" },
      { k: "planarity", label: "Max. curvature", min: 0.002, max: 0.2, step: 0.002, fmt: v => v.toFixed(3) },
      { k: "minPts", label: "Min. points in fit", min: 4, max: 40, step: 1 },
      { k: "minCos", label: "Min. incidence", min: 0, max: 0.6, step: 0.01, fmt: v => Math.round(Math.asin(v) / DEG) + "° to surface" },
      { k: "tolAbs", label: "Same-surface tolerance", min: 0.05, max: 0.5, step: 0.01, unit: " m" },
      { k: "tolRel", label: "Tolerance growth", min: 0, max: 0.1, step: 0.005, pct: true },
      { k: "noiseFlat", label: "Flat test", min: 0, max: 5, step: 0.25, fmt: v => v ? `residual ≤ ${v}× noise floor` : "curvature only" } ] },
  { key: "objects", title: "Object detection", toggle: true, preset: false, host: "objects",
    help: "Separates people and objects: learns the empty scene per beam (slowly, so people standing still stay " +
          "visible), takes returns clearly in front of it, groups neighbouring beams that lie on the same surface " +
          "(range-image segmentation, angle criterion), merges fragments, tracks each object with a Kalman filter " +
          "and classifies it from its box (height, footprint, motion).",
    params: [
      { k: "scope", label: "Detect", min: 0, max: 1, step: 1, fmt: v => v ? "foreground + static details" : "foreground only" },
      { k: "learn", label: "Background learning time", min: 2, max: 120, step: 1, unit: " s" },
      { k: "minDiff", label: "Min. distance in front of background", min: 0.05, max: 0.6, step: 0.01, unit: " m" },
      { k: "theta", label: "Segmentation angle θ", min: 2, max: 30, step: 1, unit: "°" },
      { k: "margin", label: "Segmentation noise margin", min: 0, max: 0.3, step: 0.01, unit: " m" },
      { k: "minPoints", label: "Min. points per object", min: 3, max: 100, step: 1 },
      { k: "mergeDist", label: "Merge fragments within", min: 0, max: 1, step: 0.05, unit: " m" },
      { k: "gate", label: "Tracking gate", min: 0.2, max: 2, step: 0.05, unit: " m" },
      { k: "coast", label: "Keep lost objects", min: 0, max: 50, step: 1, fmt: v => `${v} scans (${(v / 10).toFixed(1)} s)` } ] },
  { key: "mesh", title: "Mesh / lines", toggle: false,
    help: "Neighbours further apart in distance than this are not connected (object edges).",
    params: [
      { k: "jump", label: "Break at jump", min: 0.05, max: 3, step: 0.05, unit: " m" },
      { k: "jumpRel", label: "Jump growth", min: 0, max: 0.1, step: 0.005, pct: true } ] },
];

export const PRESET_KEYS = STAGES.filter(s => s.preset !== false).map(s => s.key);
/** stages that stay user-controlled in auto mode (content choices, not quality tuning) */
export const USER_STAGES: ReadonlySet<StageKey> = new Set<StageKey>(["intensity", "objects"]);

export const DEFAULT_INTENSITY: Config["intensity"] = { on: false, min: 0, max: 400 };
export const DEFAULT_LAYERCAL: Config["layercal"] = { on: true, rate: 0.3 };
export const DEFAULT_ADAPTIVE: Config["adaptive"] = { on: true, minCluster: 8, growBeams: 12, hold: 10, dynWindow: 1, dynSpatial: 1 };   // tuned on a recorded walk
export const DEFAULT_OBJECTS: Config["objects"] = { on: true, scope: 0, learn: 20, minDiff: 0.15, theta: 10, margin: 0.08, minPoints: 8, mergeDist: 0.3, gate: 0.8, coast: 10 };

type PresetPart = Pick<Config, "outlier" | "temporal" | "history" | "spatial" | "planes" | "mesh">;
const MEDIUM: PresetPart = {
  outlier: { on: true, win: 2, need: 1, abs: 0.15, rel: 0.03 },
  temporal: { on: true, window: 10, k: 3, minGate: 0.1, confirm: 2, noiseFloor: 0.02, hold: 2 },
  history: { on: true, minValid: 0.5, maxJump: 0.4, weight: 1 },
  spatial: { on: true, wb: 3, wl: 0, srAbs: 0.05, srRel: 0.01, srNoise: 0 },
  planes: { on: true, wb: 4, wl: 1, planarity: 0.02, minPts: 8, minCos: 0.15, tolAbs: 0.2, tolRel: 0.03, noiseFlat: 0 },
  mesh: { jump: 0.5, jumpRel: 0.02 },
};
function variant(edit: (p: PresetPart) => void): PresetPart { const p = structuredClone(MEDIUM); edit(p); return p; }
export const PRESETS: Record<"off" | "light" | "medium" | "strong", PresetPart> = {
  off: variant(p => { for (const k of ["outlier", "temporal", "history", "spatial", "planes"] as const) p[k].on = false; }),
  light: variant(p => {
    Object.assign(p.temporal, { window: 4, confirm: 1 });
    Object.assign(p.history, { minValid: 0.3, maxJump: 0.6, weight: 0.5 });
    Object.assign(p.spatial, { wb: 2 });
    Object.assign(p.planes, { wb: 3, planarity: 0.01 });
  }),
  medium: structuredClone(MEDIUM),
  strong: variant(p => {
    Object.assign(p.outlier, { win: 3, need: 2, abs: 0.1, rel: 0.02 });
    Object.assign(p.temporal, { window: 30, confirm: 3 });
    Object.assign(p.history, { minValid: 0.7, maxJump: 0.25, weight: 2 });
    Object.assign(p.spatial, { wb: 6, wl: 1 });
    Object.assign(p.planes, { wb: 7, planarity: 0.06 });
  }),
};
export type PresetName = keyof typeof PRESETS;

export function defaultConfig(): Config {
  return { ...structuredClone(PRESETS.medium), intensity: { ...DEFAULT_INTENSITY }, layercal: { ...DEFAULT_LAYERCAL },
           adaptive: { ...DEFAULT_ADAPTIVE }, objects: { ...DEFAULT_OBJECTS } };
}

/** cfg with a preset applied (filters, calibration, adaptivity and objects untouched) */
export function withPreset(cfg: Config, name: PresetName): Config {
  return { ...cfg, ...structuredClone(PRESETS[name]) };
}

/** name of the preset `cfg` matches, or "custom" */
export function matchingPreset(cfg: Config): PresetName | "custom" {
  const pick = (c: PresetPart) => JSON.stringify(PRESET_KEYS.map(k => c[k as keyof PresetPart]));
  return (Object.keys(PRESETS) as PresetName[]).find(n => pick(PRESETS[n]) === pick(cfg)) ?? "custom";
}

/** merge stored (possibly old or partial) settings onto defaults, keeping only known keys and types */
export function mergeConfig(base: Config, stored: unknown): Config {
  const out = structuredClone(base);
  if (!stored || typeof stored !== "object") return out;
  for (const key of Object.keys(out) as StageKey[]) {
    const src = (stored as Record<string, unknown>)[key];
    if (!src || typeof src !== "object") continue;
    const dst = out[key] as Record<string, number | boolean>;
    for (const [k, v] of Object.entries(src as Record<string, unknown>))
      if (k in dst && typeof v === typeof dst[k]) dst[k] = v as number | boolean;
  }
  return out;
}

export const fmtParam = (p: Param, v: number): string => p.fmt ? p.fmt(v) : p.pct ? `+${(v * 100).toFixed(1)} % of range`
  : (Number.isInteger(p.step) ? String(v) : v.toFixed(p.step < 0.01 ? 3 : 2)) + (p.unit || "");
