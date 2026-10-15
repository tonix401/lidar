// The head of the Processing section: auto / manual, the preset (manual only) and "Reset to defaults".
// The stages below are StageControls.
import type { PresetName } from "../config/config";
import type { Mode } from "../config/state";
import { $ } from "./dom";
import { setInfo } from "./info";

export interface ModeEvents {
  mode(m: Mode): void;
  preset(name: PresetName): void;
  resetAll(): void;
}

export class ModeControls {
  constructor(events: ModeEvents) {
    $<HTMLSelectElement>("mode").onchange = e => events.mode((e.target as HTMLSelectElement).value as Mode);
    $<HTMLSelectElement>("preset").onchange = e => events.preset((e.target as HTMLSelectElement).value as PresetName);
    $("resetCfg").onclick = () => events.resetAll();
  }

  /** `learning`: auto mode has no noise estimate yet */
  sync(mode: Mode, preset: PresetName | "custom", learning: boolean): void {
    const auto = mode === "auto";
    $<HTMLSelectElement>("mode").value = mode;
    const sel = $<HTMLSelectElement>("preset");
    sel.value = preset;
    sel.closest(".row")!.toggleAttribute("hidden", auto);
    $("resetCfg").hidden = auto;
    setInfo($("autoInfo"), auto ? (learning ? "Still learning the scene. " : "") +
      "Auto: the filter settings follow the measured noise and motion (see Statistics) and update every second. Intensity filter, " +
      "radial cells, remembered walls, object detection and the on/off of clean outlines stay yours. Switch to manual to see and edit everything."
      : "Manual: every stage and parameter is yours; the preset sets the smoothing stages at once ('off' = raw ranges).");
  }
}
