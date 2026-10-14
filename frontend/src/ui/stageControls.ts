// Collapsible settings section per pipeline stage, generated from STAGES.
import { fmtParam, STAGES, USER_STAGES, type Config, type Stage, type StageKey } from "../config/config";
import { el } from "./dom";

export interface StageControlsEvents {
  change(key: StageKey, param: string, value: number | boolean): void;
  resetCalibration(): void;
  extraOpened(kind: "histogram" | "layerbias"): void;
}

export class StageControls {
  readonly histogram?: HTMLCanvasElement;
  readonly layerBias?: HTMLCanvasElement;
  private inputs = new Map<string, HTMLInputElement>();
  private labels = new Map<string, HTMLSpanElement>();
  private sections = new Map<StageKey, HTMLDetailsElement>();

  constructor(hosts: { default: HTMLElement; objects: HTMLElement }, events: StageControlsEvents, stages: Stage[] = STAGES) {
    for (const s of stages) {
      const det = el("details", { className: "stage" });
      det.dataset.key = s.key;
      const sum = el("summary", { title: s.help });
      if (s.toggle) {
        const cb = el("input", { type: "checkbox", id: `cfg-${s.key}-on` });
        cb.addEventListener("click", e => e.stopPropagation());       // don't fold the section
        cb.addEventListener("change", () => events.change(s.key, "on", cb.checked));
        sum.append(cb);
        this.inputs.set(`${s.key}.on`, cb);
      }
      sum.append(el("span", { className: "name", textContent: s.title }));
      det.append(sum, el("div", { className: "note", textContent: s.help + (s.note ? " " + s.note : "") }));
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
        const id = `cfg-${s.key}-${p.k}`, val = el("span", { id: `${id}-val` });
        const inp = el("input", { type: "range", id, min: String(p.min), max: String(p.max), step: String(p.step) });
        inp.addEventListener("input", () => events.change(s.key, p.k, +inp.value));
        det.append(el("div", { className: "param" }, el("div", { className: "top" }, el("label", { htmlFor: id, textContent: p.label }), val), inp));
        this.inputs.set(`${s.key}.${p.k}`, inp); this.labels.set(`${s.key}.${p.k}`, val);
      }
      (s.host === "objects" ? hosts.objects : hosts.default).append(det);
      this.sections.set(s.key, det);
    }
  }

  /** show cfg; in auto mode everything except the user stages is read-only */
  sync(cfg: Config, auto: boolean, stages: Stage[] = STAGES): void {
    for (const s of stages) {
      const c = cfg[s.key] as Record<string, number | boolean>;
      const on = this.inputs.get(`${s.key}.on`);
      if (on) on.checked = !!c.on;
      this.sections.get(s.key)?.classList.toggle("off", s.toggle && !c.on);
      for (const p of s.params) {
        this.inputs.get(`${s.key}.${p.k}`)!.value = String(c[p.k]);
        this.labels.get(`${s.key}.${p.k}`)!.textContent = fmtParam(p, c[p.k] as number);
      }
      const locked = auto && !USER_STAGES.has(s.key);
      this.sections.get(s.key)?.querySelectorAll("input").forEach(i => { i.disabled = locked; });
    }
  }

  isOpen(kind: "histogram" | "layerbias"): boolean {
    const cv = kind === "histogram" ? this.histogram : this.layerBias;
    return !!cv?.closest("details")?.open;
  }
}
