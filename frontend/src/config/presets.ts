// Smoothing presets: settings for the preset stages (StageDef.preset) at once. "medium" is their defaults;
// the others are edits of it. "off" also switches the rawOff stages off, so that it shows the raw ranges.
import { defaultConfig, STAGES, type Config, type StageKey } from "./stages";

export const PRESET_KEYS = STAGES.filter(s => s.preset).map(s => s.key);
/** the "off" preset also switches these off; the other presets switch the default-on ones back on and leave
 *  the opt-in ones (intensity filter, radial cells) as they are */
export const RAW_OFF: readonly StageKey[] = STAGES.filter(s => s.rawOff).map(s => s.key);
const DEFAULT_ON: ReadonlySet<StageKey> = new Set(STAGES.filter(s => s.rawOff && (s.defaults as { on?: boolean }).on).map(s => s.key));

type PresetPart = Pick<Config, "outlier" | "temporal" | "history" | "spatial" | "dynamic" | "planes" | "mesh" | "outline">;
const MEDIUM = Object.fromEntries(PRESET_KEYS.map(k => [k, defaultConfig()[k]])) as unknown as PresetPart;

function variant(edit: (p: PresetPart) => void): PresetPart { const p = structuredClone(MEDIUM); edit(p); return p; }
export const PRESETS: Record<"off" | "light" | "medium" | "strong", PresetPart> = {
  off: variant(p => { for (const s of STAGES) if (s.preset && s.toggle) (p[s.key as keyof PresetPart] as { on: boolean }).on = false; }),
  light: variant(p => {
    Object.assign(p.temporal, { window: 4, confirm: 1 });
    Object.assign(p.history, { minValid: 0.3, maxJump: 0.6, weight: 0.5 });
    Object.assign(p.spatial, { wb: 2 });
    Object.assign(p.dynamic, { radius: 0.05 });
    Object.assign(p.planes, { wb: 3, planarity: 0.01 });
  }),
  medium: structuredClone(MEDIUM),
  strong: variant(p => {
    Object.assign(p.outlier, { win: 3, need: 2, abs: 0.1, rel: 0.02 });
    Object.assign(p.temporal, { window: 30, confirm: 3 });
    Object.assign(p.history, { minValid: 0.7, maxJump: 0.25, weight: 2 });
    Object.assign(p.spatial, { wb: 6, wl: 1 });
    Object.assign(p.dynamic, { radius: 0.12 });
    Object.assign(p.planes, { wb: 7, planarity: 0.06 });
  }),
};
export type PresetName = keyof typeof PRESETS;

/** cfg with a preset applied ("off": raw ranges, see RAW_OFF; object detection untouched) */
export function withPreset(cfg: Config, name: PresetName): Config {
  const out = { ...cfg, ...structuredClone(PRESETS[name]) } as Config;
  for (const k of RAW_OFF) (out as unknown as Record<string, unknown>)[k] =
    { ...cfg[k], on: name === "off" ? false : DEFAULT_ON.has(k) || (cfg[k] as { on: boolean }).on };
  return out;
}

/** name of the preset `cfg` matches, or "custom" */
export function matchingPreset(cfg: Config): PresetName | "custom" {
  const pick = (c: PresetPart) => JSON.stringify(PRESET_KEYS.map(k => c[k as keyof PresetPart]));
  const on = (k: StageKey) => (cfg[k] as { on: boolean }).on;
  return (Object.keys(PRESETS) as PresetName[]).find(n => pick(PRESETS[n]) === pick(cfg) &&
    (n === "off" ? RAW_OFF.every(k => !on(k)) : [...DEFAULT_ON].every(on))) ?? "custom";
}
