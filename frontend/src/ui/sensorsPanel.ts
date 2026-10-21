// The Sensors section (only with several sensors): one row per sensor (colour, rate, calibrated or not, show
// or hide it; click = the sensor the range image, the map and the statistics show), and the guided
// calibration (fusion/calib/calibrator.ts): its steps, progress and results.
import { css } from "@mrs6000/processing/core/colors";
import type { RGB } from "@mrs6000/processing/core/types";
import type { CalibPhase } from "@mrs6000/processing/fusion/calib/calibrator";
import type { SensorCalibration } from "@mrs6000/processing/fusion/calib/rig";
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
  calibrate(): void; cancel(): void; accept(): void; discard(): void;
}

const fmtPose = (p: Pose): string => {
  const q = toParams(p);
  return `x ${q.x.toFixed(2)} · y ${q.y.toFixed(2)} · z ${q.z.toFixed(2)} m · yaw ${q.yaw.toFixed(1)}° · pitch ${q.pitch.toFixed(1)}° · roll ${q.roll.toFixed(1)}°`;
};

export class SensorsPanel {
  private at = 0;

  constructor(private ev: SensorsEvents) {
    $("calStart").onclick = () => ev.calibrate();
    $("calCancel").onclick = () => ev.cancel();
    $("calAccept").onclick = () => ev.accept();
    $("calDiscard").onclick = () => ev.discard();
  }

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

  /** the calibration's state: what to do now, progress, and the results to accept or discard */
  calibration(phase: CalibPhase, text: string, result: SensorCalibration[] | null, error = ""): void {
    const running = phase === "empty" || phase === "walk";
    $("calStart").hidden = running;
    $("calStart").textContent = phase === "done" || phase === "failed" ? "Calibrate again" : "Calibrate…";
    $("calCancel").hidden = !running;
    $("calActions").hidden = phase !== "done";
    $("calInfo").textContent = phase === "failed" ? `calibration failed: ${error}` : text;
    $("calResult").replaceChildren(...(phase === "done" && result ? result.map((r, k) => {
      const parts = k === 0 ? ["the world's origin (levelled by its floor)"] : [
        r.walk ? `walk ${(r.walk.rms * 100).toFixed(1)} cm` : "no walk",
        r.icp && isFinite(r.icp.median) ? `scene ${(r.icp.median * 1000).toFixed(0)} mm · ${(r.icp.overlap * 100).toFixed(0)} % overlap` : "no scene match",
      ];
      return el("div", { className: "calrow" },
        el("div", { textContent: `${r.name}: ${parts.join(" · ")}`, title: fmtPose(r.pose) }),
        ...r.problems.map(p => el("div", { className: "warn", textContent: p })));
    }) : []));
  }
}
