// "My presets" in the Processing section: pick a saved one, delete it, or save the settings in effect under a name
// (typing the name of an existing one replaces it). The storage is UserPresets.
import { $, el } from "./dom";

export interface PresetEvents {
  load(name: string): void;
  save(name: string): void;
  remove(name: string): void;
}

export class PresetControls {
  private select = $<HTMLSelectElement>("userPreset");
  private name = $<HTMLInputElement>("presetName");
  private saveBtn = $<HTMLButtonElement>("presetSave");
  private existing: string[] = [];

  constructor(events: PresetEvents) {
    this.select.onchange = () => {
      this.name.value = this.select.value;
      this.refresh();
      if (this.select.value) events.load(this.select.value);
    };
    this.name.oninput = () => this.refresh();
    this.name.onkeydown = e => { if (e.key === "Enter") this.saveBtn.click(); };
    this.saveBtn.onclick = () => events.save(this.name.value);
    $("presetDelete").onclick = () => { if (this.select.value) events.remove(this.select.value); };
  }

  /** `names`: the saved presets; `selected`: the one whose settings are in effect unchanged ("": none) */
  sync(names: string[], selected: string): void {
    this.existing = names;
    this.select.replaceChildren(el("option", { value: "", textContent: "–" }), ...names.map(n => el("option", { value: n, textContent: n })));
    this.select.value = selected;
    if (selected) this.name.value = selected;
    this.refresh();
  }

  private refresh(): void {
    this.saveBtn.textContent = this.existing.includes(this.name.value.trim()) ? "Overwrite" : "Save";
    $("presetDelete").hidden = !this.select.value;
  }
}
