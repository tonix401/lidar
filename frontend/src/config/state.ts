// The processing settings in effect: auto mode (derived from the measured noise, with the user's own stages
// kept) or manual (the user's settings as they are). `manual` is what is stored; in auto mode the user's
// stages (StageDef.auto "user" / "toggle") are carried into it, so switching modes keeps them. No DOM.
import type { Grid } from "../pipeline/grid";
import { autoConfig, estimateNoise, type NoiseEstimate } from "./auto";
import { defaultConfig, mergeConfig, USER_STAGES, USER_TOGGLES, withPreset, type Config, type PresetName,
         type StageKey } from "./config";

export type Mode = "auto" | "manual";

export class ConfigState {
  mode: Mode = "auto";
  manual: Config = defaultConfig();
  cfg: Config;
  /** the last noise estimate (auto mode), null while still learning the scene */
  estimate: NoiseEstimate | null = null;
  private noise = 0.02;

  /** `stored`: what toJSON() returned in an earlier session (anything else: defaults) */
  constructor(stored?: unknown) {
    const s = stored as { mode?: unknown; manual?: unknown } | null | undefined;
    if (s && typeof s === "object") {
      if (s.mode === "auto" || s.mode === "manual") this.mode = s.mode;
      this.manual = mergeConfig(defaultConfig(), s.manual);
    }
    this.cfg = this.derived();
  }

  get auto(): boolean { return this.mode === "auto"; }

  toJSON(): { mode: Mode; manual: Config } { return { mode: this.mode, manual: this.manual }; }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.set(this.derived());
  }

  changeParam(key: StageKey, param: string, value: number | boolean): void {
    const c = structuredClone(this.cfg);
    (c[key] as Record<string, number | boolean>)[param] = value;
    if (key === "intensity") {                               // keep min ≤ max
      if (param === "min" && c.intensity.max < c.intensity.min) c.intensity.max = c.intensity.min;
      if (param === "max" && c.intensity.min > c.intensity.max) c.intensity.min = c.intensity.max;
    }
    this.set(c);
  }

  resetStage(key: StageKey): void { this.set({ ...this.cfg, [key]: structuredClone(defaultConfig()[key]) }); }

  applyPreset(name: PresetName): void { this.set(withPreset(this.cfg, name)); }

  /** everything back to the defaults (the "medium" preset) */
  resetAll(): void { this.set(withPreset(defaultConfig(), "medium")); }

  /** auto mode: re-derive the tuned stages from the scene's current noise (not stored: the user changed nothing) */
  autoTune(g: Grid | null): void {
    const est = g ? estimateNoise(g) : null;
    if (est) { this.noise = est.noise; this.estimate = est; }
    const c = autoConfig(this.manual, this.noise);
    for (const k of USER_STAGES) (c as unknown as Record<string, unknown>)[k] = this.cfg[k];
    this.cfg = c;
  }

  private derived(): Config { return this.auto ? autoConfig(this.manual, this.noise) : structuredClone(this.manual); }

  /** a change by the user: in effect, and remembered in `manual` */
  private set(cfg: Config): void {
    this.cfg = cfg;
    if (!this.auto) this.manual = structuredClone(cfg);
    else {
      for (const k of USER_STAGES) (this.manual as unknown as Record<string, unknown>)[k] = structuredClone(cfg[k]);
      for (const k of USER_TOGGLES) (this.manual[k] as { on: boolean }).on = (cfg[k] as { on: boolean }).on;
    }
  }
}
