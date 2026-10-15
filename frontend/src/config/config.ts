// The pipeline settings: the stages (stages.ts; each declared in its own module), presets (presets.ts),
// and helpers for stored settings and typed-in values. The panel's stage controls are generated from STAGES.
import type { Config, StageKey } from "./stages";
import { STAGES } from "./stages";
import type { Param } from "./types";

export { defaultConfig, stageDef, STAGES, type Config, type StageKey } from "./stages";
export { matchingPreset, PRESET_KEYS, PRESETS, RAW_OFF, withPreset, type PresetName } from "./presets";
export type { Param, StageDef as Stage, ViewMode } from "./types";

/** stages that stay user-controlled in auto mode (content choices and experiments, not quality tuning) */
export const USER_STAGES: ReadonlySet<StageKey> = new Set(STAGES.filter(s => s.auto === "user").map(s => s.key));
/** auto-tuned stages whose on/off stays the user's in auto mode (their parameters are set automatically) */
export const USER_TOGGLES: ReadonlySet<StageKey> = new Set(STAGES.filter(s => s.auto === "toggle").map(s => s.key));

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

/** how a parameter is typed in: scale from the stored value and the unit shown next to the field */
export function editSpec(p: Param): { scale: number; unit: string } {
  return p.edit ?? (p.pct ? { scale: 100, unit: "% of range" } : { scale: 1, unit: (p.unit ?? "").trim() });
}

/** a typed value (in editSpec units) → the stored value: clamped to the parameter's range, whole numbers for whole steps */
export function parseParam(p: Param, typed: number): number | null {
  if (!isFinite(typed)) return null;
  const v = Math.min(p.max, Math.max(p.min, typed / editSpec(p).scale));
  return Number.isInteger(p.step) ? Math.round(v) : +v.toPrecision(6);
}

export const fmtParam = (p: Param, v: number): string => p.fmt ? p.fmt(v) : p.pct ? `+${(v * 100).toFixed(1)} % of range`
  : (Number.isInteger(p.step) ? String(v) : fixedOrExact(v, p.step < 0.01 ? 3 : 2)) + (p.unit || "");

/** v with `dec` decimals, or all of its digits when it has more (a typed-in exact value) */
const fixedOrExact = (v: number, dec: number) => +v.toFixed(dec) === v ? v.toFixed(dec) : String(+v.toPrecision(6));
