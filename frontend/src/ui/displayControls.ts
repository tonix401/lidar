// The Display section: draw mode, colouring and its legend, layer, mount, point size, max range, walls behind
// objects, and the object overlays. Changes `ui` in place, remembers what is stored, and asks the app to redraw.
import type { Store } from "../config/storage";
import { turboGradientCss } from "../core/colors";
import type { Mount } from "../core/types";
import type { ColorBy, Geometry } from "../render/geometry";
import type { DrawMode } from "../render/scene3d";
import { $ } from "./dom";
import { MAX_RANGE, OBJECT_TOGGLES, saveUi, type UiSettings } from "./settings";

export interface DisplayEvents {
  draw(): void;                        // ui.draw changed
  mount(m: Mount): void;               // the user picked a mount
  pointSize(): void;
  maxRange(): void;
  /** redraw; `refine`: re-run the spatial stages first */
  rebuild(refine: boolean): void;
}

export class DisplayControls {
  constructor(private ui: UiSettings, store: Store, events: DisplayEvents) {
    const sel = (id: string, apply: (v: string) => void, value: string) => {
      const s = $<HTMLSelectElement>(id); s.value = value;
      s.onchange = () => { apply(s.value); events.rebuild(true); };
    };
    sel("draw", v => { ui.draw = v as DrawMode; events.draw(); }, ui.draw);
    sel("colorBy", v => { ui.colorBy = v as ColorBy; this.showLegend(); }, ui.colorBy);
    sel("layerSel", v => { ui.layer = +v; }, "-1");
    sel("mount", v => events.mount(v as Mount), ui.mount);
    this.showLegend();
    $("legend").style.background = turboGradientCss();
    const fill = $<HTMLInputElement>("fillWalls");
    fill.checked = ui.fillWalls;
    fill.onchange = () => { ui.fillWalls = fill.checked; saveUi(store, ui, "fillWalls"); events.rebuild(false); };
    const size = $<HTMLInputElement>("size");
    size.oninput = () => { ui.pointSize = +size.value; $("sizeVal").textContent = `${ui.pointSize} px`; events.pointSize(); };
    const range = $<HTMLInputElement>("range");
    range.value = String(ui.maxRange);
    range.onchange = () => {                                  // Enter or leaving the field
      const v = range.valueAsNumber;
      if (!isFinite(v)) { range.value = String(ui.maxRange); return; }
      ui.maxRange = Math.min(MAX_RANGE[1], Math.max(MAX_RANGE[0], v));
      range.value = String(ui.maxRange);
      saveUi(store, ui, "maxRange");
      events.maxRange(); events.rebuild(true);
    };
    range.onkeydown = e => { if (e.key === "Enter") range.blur(); };
    for (const [id, key] of Object.entries(OBJECT_TOGGLES)) {
      const cb = $<HTMLInputElement>(id);
      cb.checked = ui[key];
      cb.onchange = () => { ui[key] = cb.checked; saveUi(store, ui, key); this.syncDim(); events.rebuild(true); };
    }
    this.syncDim();
  }

  /** the mount as shown (also when it follows the device or a recording) */
  setMount(m: Mount): void { $<HTMLSelectElement>("mount").value = m; }

  /** the layer choices for a scan of L layers */
  setLayers(L: number): void {
    $("layerSel").replaceChildren(new Option("all", "-1"), ...Array.from({ length: L }, (_, i) => new Option(String(i), String(i))));
  }

  /** "walls behind moving objects" only with remembered walls on */
  sync(wallsOn: boolean): void { $("fillWalls").closest(".row")!.toggleAttribute("hidden", !wallsOn); }

  /** the colour legend: the value range of the current colouring, or counts for the classes */
  legend(geo: Geometry, cellsOn: boolean): void {
    const by = this.ui.colorBy, isArea = by === "area", isCell = by === "cell";
    $("legend").style.visibility = isArea || isCell ? "hidden" : "";
    if (isArea) {
      const [f, d, m] = geo.areaCounts;
      $("legMin").textContent = `flat ${f} · detail ${d}`; $("legMax").textContent = `moving ${m}`;
    } else if (isCell) {
      $("legMin").textContent = cellsOn ? "one colour per depth slot" : "radial cells are off"; $("legMax").textContent = "grey: none";
    } else {
      const unit = { rssi: "", dist: " m", height: " m", layer: "", uniform: "", noise: " mm", conf: "", area: "", cell: "" }[by];
      const fmt = (v: number) => by === "dist" || by === "height" ? v.toFixed(1) : by === "conf" ? v.toFixed(2) : String(Math.round(v));
      $("legMin").textContent = fmt(geo.lo) + unit; $("legMax").textContent = fmt(geo.hi) + unit;
    }
  }

  private showLegend(): void { $("legendBox").classList.toggle("hidden", this.ui.colorBy === "uniform"); }

  /** "dim background" only does something with highlighting on */
  private syncDim(): void {
    const dim = $<HTMLInputElement>("oDim");
    dim.disabled = !this.ui.highlight;
    dim.parentElement!.classList.toggle("disabled", dim.disabled);
  }
}
