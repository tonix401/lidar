import type { Config } from "../config/config";

/** RSSI histogram with the kept range highlighted (sqrt scale so small bins stay visible) */
export function drawHistogram(cv: HTMLCanvasElement, hist: Uint32Array, c: Config["intensity"]): void {
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const W = cv.width, H = cv.height, n = hist.length, peak = Math.max(1, ...hist);
  ctx.clearRect(0, 0, W, H);
  for (let i = 0; i < n; i++) {
    const v = i * 400 / n, kept = !c.on || (v >= c.min && v <= c.max);
    const h = Math.max(hist[i] ? 2 : 0, Math.sqrt(hist[i] / peak) * (H - 4));
    ctx.fillStyle = kept ? "#4aa3ff" : "#3a4250";
    ctx.fillRect(i * W / n, H - h, W / n - 1, h);
  }
}

/** per-layer calibration offsets as bars */
export function drawLayerBias(cv: HTMLCanvasElement, bias: Float32Array): void {
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const W = cv.width, H = cv.height, L = bias.length;
  const span = Math.max(0.02, ...Array.from(bias, Math.abs));
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#2a313c"; ctx.fillRect(0, H / 2, W, 1);
  for (let l = 0; l < L; l++) {
    const v = bias[l], h = v / span * (H / 2 - 14);
    ctx.fillStyle = v >= 0 ? "#4aa3ff" : "#d29922";
    ctx.fillRect(l * W / L + 2, h >= 0 ? H / 2 - h : H / 2, W / L - 4, Math.abs(h));
  }
  ctx.fillStyle = "#8b95a3"; ctx.font = "20px system-ui";
  ctx.fillText(`±${Math.round(span * 1000)} mm   layer 0 → ${L - 1}`, 6, 22);
}
