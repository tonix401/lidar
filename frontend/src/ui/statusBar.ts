// The title and the Stream / Device status boxes: device name, what is shown (live / replaying a file), frame
// rate and size, and the status dots.
import type { FrameMeta, ServerState } from "../core/types";
import { deviceSummary, renderDevice } from "./devicePanel";
import { $ } from "./dom";

export class StatusBar {
  private lastFrameAt = 0;
  private streamText = "–";

  /** a frame arrived */
  frame(meta: FrameMeta): void {
    this.lastFrameAt = performance.now();
    $("rate").textContent = meta.rate.toFixed(1) + " Hz";
    $("points").textContent = meta.points.toLocaleString();
    $("geom").textContent = `${meta.layers} × ${meta.beams}`;
    this.streamText = `${meta.layers}×${meta.beams} @ ${meta.rate.toFixed(1)} Hz`;
  }

  replaying(file: string): void { $("subtitle").textContent = $("subtitle").title = `replaying ${file}`; }

  live(): void { $("subtitle").textContent = "live"; }

  /** the device's REST values (/api/status); names the device in the title unless a recording plays */
  device(d: Record<string, unknown>, replaying: boolean): void {
    if (d.DeviceType && !replaying) { $("title").textContent = String(d.DeviceType); $("subtitle").textContent = `SN ${d.SerialNumber} · FW ${d.FirmwareVersion}`; }
    renderDevice(d);
  }

  server(s: ServerState): void {
    const dev = deviceSummary(s);
    $("sumDevice").textContent = dev.text; $("sumDeviceDot").className = "dot " + dev.dot;
  }

  /** per animation frame: the stream dot (green = data, amber = paused, red = no data) */
  tick(paused: boolean): void {
    const age = performance.now() - this.lastFrameAt, live = this.lastFrameAt && age < 500;
    const dot = "dot " + (paused ? "warn" : live ? "ok" : "err");
    $("streamDot").className = dot; $("sumStreamDot").className = dot;
    $("sumStream").textContent = paused ? "paused" : live ? this.streamText : this.lastFrameAt ? "no data" : "–";
  }
}
