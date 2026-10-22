// The Sensors section (only with several sensors): one row per sensor (colour, rate, calibrated or not, show
// or hide it; click = the sensor the range image, the map and the statistics show). Calibrating is done on the
// source server's page.
import { css } from "@mrs6000/processing/core/colors";
import type { RGB } from "@mrs6000/processing/core/types";
import { toParams, type Pose } from "@mrs6000/processing/fusion/pose";
import { $, el } from "./dom";

export interface SensorRow {
  name: string; color: RGB; pose: Pose; calibrated: string;
  rate: number; live: boolean;       // frames arriving
  primary: boolean; visible: boolean;
}

export interface SensorsEvents {
  primary(k: number): void;
  visible(k: number, on: boolean): void;
}

const fmtPose = (p: Pose): string => {
  const q = toParams(p);
  return `x ${q.x.toFixed(2)} · y ${q.y.toFixed(2)} · z ${q.z.toFixed(2)} m · yaw ${q.yaw.toFixed(1)}° · pitch ${q.pitch.toFixed(1)}° · roll ${q.roll.toFixed(1)}°`;
};

export class SensorsPanel {
  private at = 0;

  constructor(private ev: SensorsEvents) {}

  /** the section is only there with several sensors */
  show(on: boolean): void { $("secSensors").hidden = !on; }

  /** rows, at most 4 times a second unless forced (so they stay clickable) */
  render(rows: SensorRow[], force = false): void {
    const now = performance.now();
    if (!force && now - this.at < 250) return;
    this.at = now;
    $("sensorCount").textContent = String(rows.length);
    $("sensorList").replaceChildren(...rows.map((r, k) => {
      const box = el("input", { type: "checkbox", checked: r.visible, title: "show in the 3D view" });
      box.onclick = e => { e.stopPropagation(); this.ev.visible(k, box.checked); };
      const meta = (r.live ? `${r.rate.toFixed(1)} Hz` : "no data") + " · " + (r.calibrated ? "calibrated" : k === 0 ? "the world's origin" : "not calibrated");
      const row = el("div", { className: "orow" + (r.primary ? " sel" : ""), onclick: () => this.ev.primary(k),
                              title: `${fmtPose(r.pose)}${r.calibrated ? `\ncalibrated ${r.calibrated}` : ""}\nclick: show it in the range image, map and statistics` },
        el("span", { className: "sw" }), el("span", { className: "nm", textContent: r.name }), el("span", { className: "mt", textContent: meta }), box);
      (row.firstChild as HTMLElement).style.background = css(r.color);
      return row;
    }));
  }
}
