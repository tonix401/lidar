// Collapsible settings section per pipeline stage, generated from STAGES.
//  • each parameter: a slider, and its value can be clicked to type an exact number (Enter applies, Esc cancels);
//  • a dot marks parameters (and stages) that differ from the defaults, with a per-stage reset;
//  • in auto mode the auto-set stages stay visible, read-only, showing the values auto chose.
import { defaultConfig, editSpec, fmtParam, parseParam, stageDef, STAGES, type Config, type Param, type Stage,
         type StageKey } from "../config/config";
import { el } from "./dom";
import { info } from "./info";

export interface StageControlsEvents {
  change(key: StageKey, param: string, value: number | boolean): void;
  resetStage(key: StageKey): void;
  resetCalibration(): void;
  extraOpened(kind: "histogram" | "layerbias"): void;
}

/** what the user may change of a stage: everything, only its on/off switch (auto-tuned), or nothing (auto) */
export function editable(key: StageKey, auto: boolean): "all" | "toggle" | "none" {
  const role = stageDef(key).auto;
  return !auto || role === "user" ? "all" : role === "toggle" ? "toggle" : "none";
}

export class StageControls {
  readonly histogram?: HTMLCanvasElement;
  readonly layerBias?: HTMLCanvasElement;
  private inputs = new Map<string, HTMLInputElement>();
  private labels = new Map<string, HTMLSpanElement>();
  private rows = new Map<string, HTMLElement>();
  private sections = new Map<StageKey, HTMLDetailsElement>();
  private resets = new Map<StageKey, HTMLButtonElement>();
  private defaults = defaultConfig();

  constructor(hosts: { default: HTMLElement; objects: HTMLElement; display: HTMLElement }, private events: StageControlsEvents,
              stages: Stage[] = STAGES) {
    for (const s of stages) {
      const det = el("details", { className: "stage" });
      det.dataset.key = s.key;
      if (s.views) det.dataset.views = s.views.join(" ");
      const sum = el("summary");
      if (s.toggle) {
        const cb = el("input", { type: "checkbox", id: `cfg-${s.key}-on` });
        cb.addEventListener("click", e => e.stopPropagation());       // don't fold the section
        cb.addEventListener("change", () => events.change(s.key, "on", cb.checked));
        sum.append(cb);
        this.inputs.set(`${s.key}.on`, cb);
      }
      const auto = s.auto === "toggle" ? " In auto mode only the on/off switch is yours; the parameters are set automatically." : "";
      sum.append(el("span", { className: "name", textContent: s.title }),
                 el("span", { className: "tag", textContent: "auto", title: "set by auto mode (switch to manual to edit)" }),
                 el("span", { className: "changed", title: "changed from the default" }),
                 info(s.help + (s.note ? " " + s.note : "") + auto));
      det.append(sum);
      if (s.extra === "histogram") {
        const cv = el("canvas", { width: 480, height: 90, className: "chart" });
        (this as { histogram?: HTMLCanvasElement }).histogram = cv;
        det.append(cv);
        det.addEventListener("toggle", () => det.open && events.extraOpened("histogram"));
      }
      if (s.extra === "layerbias") {
        const cv = el("canvas", { width: 480, height: 120, className: "chart tall" });
        (this as { layerBias?: HTMLCanvasElement }).layerBias = cv;
        const btn = el("button", { textContent: "Reset calibration", onclick: () => events.resetCalibration() });
        det.append(cv, btn);
        det.addEventListener("toggle", () => det.open && events.extraOpened("layerbias"));
      }
      for (const p of s.params) {
        const id = `cfg-${s.key}-${p.k}`;
        const val = el("span", { id: `${id}-val`, className: "pval", tabIndex: 0, title: "click to type an exact value" });
        const inp = el("input", { type: "range", id, min: String(p.min), max: String(p.max), step: String(p.step) });
        inp.addEventListener("input", () => events.change(s.key, p.k, +inp.value));
        val.addEventListener("click", () => this.typeValue(s.key, p, val));
        val.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.typeValue(s.key, p, val); } });
        const row = el("div", { className: "param" },
          el("div", { className: "top" }, el("label", { htmlFor: id }, el("span", { className: "changed" }), p.label), val), inp);
        det.append(row);
        this.inputs.set(`${s.key}.${p.k}`, inp); this.labels.set(`${s.key}.${p.k}`, val); this.rows.set(`${s.key}.${p.k}`, row);
      }
      if (s.params.length) {
        const reset = el("button", { className: "reset", textContent: "Reset stage to defaults", onclick: () => events.resetStage(s.key) });
        det.append(reset);
        this.resets.set(s.key, reset);
      }
      hosts[s.host ?? "default"].append(det);
      this.sections.set(s.key, det);
    }
  }

  /** swap the value label for a number field: Enter / leaving applies, Esc cancels */
  private typeValue(key: StageKey, p: Param, val: HTMLSpanElement): void {
    const slider = this.inputs.get(`${key}.${p.k}`)!;
    if (slider.disabled || val.hidden) return;
    const { scale, unit } = editSpec(p);
    const field = el("input", { type: "number", className: "pedit", step: "any", value: String(+(+slider.value * scale).toPrecision(6)) });
    field.setAttribute("aria-label", p.label);
    const box = el("span", { className: "pedit-box" }, field, unit ? " " + unit : "");
    let done = false;
    const finish = (apply: boolean) => {
      if (done) return;
      done = true;
      const v = parseParam(p, field.valueAsNumber);
      box.remove(); val.hidden = false;
      if (apply && v !== null) this.events.change(key, p.k, v);
      val.focus();
    };
    field.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    field.addEventListener("blur", () => finish(true));
    val.hidden = true;
    val.after(box);
    field.focus(); field.select();
  }

  /** show cfg: values, the changed-from-default markers, and what auto mode leaves editable */
  sync(cfg: Config, auto: boolean, stages: Stage[] = STAGES): void {
    for (const s of stages) {
      const c = cfg[s.key] as Record<string, number | boolean>, d = this.defaults[s.key] as Record<string, number | boolean>;
      const can = editable(s.key, auto), sec = this.sections.get(s.key)!;
      const on = this.inputs.get(`${s.key}.on`);
      if (on) { on.checked = !!c.on; on.disabled = can === "none"; }
      sec.classList.toggle("off", s.toggle && !c.on);
      sec.classList.toggle("auto", can !== "all");
      let changed = s.toggle && can !== "none" && c.on !== d.on;
      for (const p of s.params) {
        const k = `${s.key}.${p.k}`, inp = this.inputs.get(k)!, diff = can === "all" && c[p.k] !== d[p.k];
        inp.value = String(c[p.k]);
        inp.disabled = can !== "all";
        this.labels.get(k)!.textContent = fmtParam(p, c[p.k] as number);
        this.rows.get(k)!.classList.toggle("is-changed", diff);
        changed ||= diff;
      }
      sec.classList.toggle("is-changed", changed);
      this.resets.get(s.key)?.toggleAttribute("hidden", !changed || can !== "all");
    }
  }

  isOpen(kind: "histogram" | "layerbias"): boolean {
    const cv = kind === "histogram" ? this.histogram : this.layerBias;
    return !!cv?.closest("details")?.open;
  }
}
