// 2D views on a canvas:
//  "top"   orthographic bird's-eye map, sensor at the bottom looking up (x forward → up, y left → left)
//  "image" the organized range image itself, layers as rows (top = highest in the world: the sensor's
//          lowest layer when it is mounted upside down), beams as columns (left = +60°, as seen from
//          behind the sensor; the device reports azimuth in world left/right either way). Cells are as
//          tall as the layers are apart in angle (≈ 4.6 beam steps on the MRS6000), so shapes keep their
//          proportions: a cell is `cell` wide and `rowH()` tall
// Both draw the same processed data and colours as the 3D view, plus object overlays.
import { css, packABGR, scale, turbo } from "../core/colors";
import { DEG } from "../core/math";
import type { FrameMeta, RGB } from "../core/types";
import { boxCorners, trackLabel, type Track } from "../objects/tracker";
import type { Grid } from "../pipeline/grid";
import type { Geometry } from "./geometry";
import { drawParts, type DrawMode, type OverlayOptions } from "./scene3d";
import type { ThemeColors } from "../ui/theme";

export type View2DMode = "top" | "image";

export interface View2DData {
  grid: Grid;
  geo: Geometry;
  meta: FrameMeta;
  tracks: Track[];                    // confirmed tracks to draw
  overlay: OverlayOptions;
  draw: DrawMode;
  pointSize: number;
  maxRange: number;
  byDistance: boolean;                // range image: colour by distance (when the colour mode is uniform)
  upsideDown: boolean;                // sensor on its head: the range image's rows flip
  tint: (i: number, rgb: RGB) => RGB;
  follow?: Track;
}

export interface View2DCallbacks {
  data(): View2DData | null;
  describe(i: number): string;        // tooltip text for beam i
  objectAt(i: number): number;        // confirmed track id at beam i, 0 = none
  select(id: number): void;           // 0 = deselect
  panelWidth(): number;
  bottomInset(): number;              // px covered at the bottom (replay bar)
  viewDist(): number;                 // typical scene distance (m), 0 = unknown
}

export class View2D {
  mode: View2DMode = "top";
  private ctx: CanvasRenderingContext2D;
  private off = document.createElement("canvas");
  private offCtx: CanvasRenderingContext2D;
  private dpr = 1;
  private top = { scale: 0, cx: 0, cy: 0 };          // px per metre, sensor position (CSS px)
  private img = { cell: 0, ox: 0, oy: 0, aspect: 1 };   // cell width (CSS px), grid top-left, row height / width
  private drag: { x: number; y: number } | null = null;
  private c: ThemeColors = { bg: "#0e1116", border: "#2a313c", text: "#d7dde5", muted: "#8b95a3", accent: "#4aa3ff", warn: "#d29922",
                             grid: "#262d37", grid2: "#3d4654", axis: "#6e7887", mark: "#ffd33d", field: "#0d1117" };
  private downAt: { x: number; y: number } | null = null;

  constructor(private canvas: HTMLCanvasElement, private tip: HTMLElement, private cb: View2DCallbacks) {
    this.ctx = canvas.getContext("2d")!;
    this.offCtx = this.off.getContext("2d")!;
    this.size();
    window.addEventListener("resize", () => { this.size(); this.img.cell = 0; this.render(); });
    canvas.addEventListener("pointerdown", e => {
      this.drag = { x: e.clientX, y: e.clientY }; this.downAt = { ...this.drag };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointerup", e => this.click(e));
    canvas.addEventListener("pointermove", e => this.move(e));
    canvas.addEventListener("pointerleave", () => { this.tip.hidden = true; });
    canvas.addEventListener("wheel", e => this.wheel(e), { passive: false });
    canvas.addEventListener("dblclick", () => { this.fit(); this.render(); });
  }

  private size(): void {
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(innerWidth * this.dpr); this.canvas.height = Math.round(innerHeight * this.dpr);
  }

  setTheme(c: ThemeColors): void { this.c = c; this.render(); }

  setMode(mode: View2DMode): void { this.mode = mode; this.tip.hidden = true; if (mode === "top" && !this.top.scale) this.fit(); this.render(); }

  /** top: the ±60° wedge out to the typical scene distance; image: full width */
  fit(): void {
    const d = this.cb.data();
    if (this.mode === "top") {
      const pw = this.cb.panelWidth(), W = innerWidth - pw, H = innerHeight - this.cb.bottomInset();
      const maxRange = d?.maxRange ?? 60, r = Math.max(2, Math.min(this.cb.viewDist() || maxRange, maxRange) * 1.1);
      this.top.scale = Math.min((W - 40) / (2 * r * Math.sin(60 * DEG)), (H - 70) / r);
      this.top.cx = pw + W / 2; this.top.cy = H - 35;
    } else if (d) {
      const A = this.imgArea();
      this.img.aspect = this.aspectOf(d);
      this.img.cell = Math.max(1, Math.floor(Math.min(A.w / d.grid.B, A.h / (d.grid.L * this.img.aspect)) * this.dpr)) / this.dpr;
      this.img.ox = A.left + (A.w - d.grid.B * this.img.cell) / 2; this.img.oy = A.top;
    }
  }

  private imgArea() {
    const left = this.cb.panelWidth() + 70, top = 40;
    return { left, top, w: innerWidth - left - 30, h: innerHeight - top - 70 - this.cb.bottomInset() };
  }

  render(): void {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.c.bg; ctx.fillRect(0, 0, W, H);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const d = this.cb.data();
    if (!d) {
      ctx.fillStyle = this.c.muted; ctx.font = "14px system-ui"; ctx.fillText("waiting for scan data…", this.cb.panelWidth() + 30, 40);
      return;
    }
    if (this.mode === "top") {
      if (!this.top.scale) this.fit();
      if (d.follow) {                                      // keep the followed object centred
        const pw = this.cb.panelWidth();
        this.top.cx = pw + (innerWidth - pw) / 2 + d.follow.y * this.top.scale; this.top.cy = innerHeight / 2 + d.follow.x * this.top.scale;
      }
      this.renderTop(d);
    } else this.renderImage(d);
  }

  private niceStep(minPx: number): number {
    for (const s of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]) if (s * this.top.scale >= minPx) return s;
    return 200;
  }

  private renderTop(d: View2DData): void {
    const ctx = this.ctx, { scale: s, cx, cy } = this.top, P = d.geo.pos, C = d.geo.col;
    const toX = (y: number) => cx - y * s, toY = (x: number) => cy - x * s;
    const maxR = Math.min(d.maxRange, 250), step = this.niceStep(60);
    ctx.lineWidth = 1; ctx.font = "11px system-ui"; ctx.textAlign = "left";
    for (let r = step; r <= maxR; r += step) {
      ctx.strokeStyle = Math.round(r / step) % 2 === 0 ? this.c.grid2 : this.c.grid;
      ctx.beginPath(); ctx.arc(cx, cy, r * s, -Math.PI / 2 - 70 * DEG, -Math.PI / 2 + 70 * DEG); ctx.stroke();
      ctx.fillStyle = this.c.axis; ctx.fillText(`${+r.toFixed(1)} m`, cx + 4, cy - r * s - 3);
    }
    ctx.strokeStyle = this.c.accent; ctx.globalAlpha = 0.4;
    for (const a of [-60, 60]) {
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx - Math.sin(a * DEG) * maxR * s, cy - Math.cos(a * DEG) * maxR * s); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // layer lines (also for "surface": seen from above, surfaces are lines) and vertical lines (from above:
    // short radial strokes between layers), batched by quantised colour
    const parts = drawParts(d.draw), segs: [Uint32Array, number][] = [];
    if (parts.surface || parts.layerLines) segs.push([d.geo.lIdx, d.geo.nl]);
    if (parts.vLines) segs.push([d.geo.vIdx, d.geo.nv]);
    if (segs.length) {
      const paths = new Map<number, Path2D>();
      for (const [idx, n] of segs) for (let k = 0; k < n; k++) {
        const a = idx[2 * k], b = idx[2 * k + 1];
        const key = ((C[3 * a] * 15 + 0.5) | 0) << 8 | ((C[3 * a + 1] * 15 + 0.5) | 0) << 4 | ((C[3 * a + 2] * 15 + 0.5) | 0);
        let p = paths.get(key);
        if (!p) { p = new Path2D(); paths.set(key, p); }
        p.moveTo(toX(P[3 * a + 1]), toY(P[3 * a])); p.lineTo(toX(P[3 * b + 1]), toY(P[3 * b]));
      }
      ctx.lineWidth = 1;
      for (const [key, p] of paths) { ctx.strokeStyle = `rgb(${(key >> 8) * 17},${((key >> 4) & 15) * 17},${(key & 15) * 17})`; ctx.stroke(p); }
    }
    // points rasterised into an offscreen image (fast for ~22k points), then composited
    if (parts.points) {
      const W = this.canvas.width, H = this.canvas.height, dpr = this.dpr;
      if (this.off.width !== W || this.off.height !== H) { this.off.width = W; this.off.height = H; }
      const img = this.offCtx.createImageData(W, H), px = new Uint32Array(img.data.buffer);
      const sz = Math.max(1, Math.round(d.pointSize * dpr)), half = sz >> 1;
      for (let k = 0; k < d.geo.np; k++) {
        const i = d.geo.pIdx[k];
        const X = Math.round(toX(P[3 * i + 1]) * dpr) - half, Y = Math.round(toY(P[3 * i]) * dpr) - half;
        if (X < 0 || Y < 0 || X + sz > W || Y + sz > H) continue;
        const c = packABGR([C[3 * i], C[3 * i + 1], C[3 * i + 2]]);
        for (let dy = 0; dy < sz; dy++) px.fill(c, (Y + dy) * W + X, (Y + dy) * W + X + sz);
      }
      this.offCtx.putImageData(img, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(this.off, 0, 0); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.drawObjectsTop(d, toX, toY);
    ctx.fillStyle = this.c.mark;                           // sensor + scale bar
    ctx.beginPath(); ctx.moveTo(cx, cy - 9); ctx.lineTo(cx - 6, cy + 5); ctx.lineTo(cx + 6, cy + 5); ctx.closePath(); ctx.fill();
    const bar = this.niceStep(80), bx = innerWidth - 30 - bar * s, by = innerHeight - 40;
    ctx.strokeStyle = ctx.fillStyle = this.c.text; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + bar * s, by); ctx.stroke();
    ctx.textAlign = "center"; ctx.fillText(`${bar} m`, bx + bar * s / 2, by - 6);
  }

  private drawObjectsTop(d: View2DData, toX: (y: number) => number, toY: (x: number) => number): void {
    const ctx = this.ctx, o = d.overlay;
    ctx.font = "12px system-ui"; ctx.textAlign = "left";
    for (const t of d.tracks) {
      const a = o.selected && t.id !== o.selected ? 0.35 : t.misses ? 0.55 : 1, col = css(t.color, a);
      if (o.trails && t.trail.length >= 4) {
        ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
        ctx.beginPath();
        for (let k = 0; k < t.trail.length; k += 2) k ? ctx.lineTo(toX(t.trail[k + 1]), toY(t.trail[k])) : ctx.moveTo(toX(t.trail[k + 1]), toY(t.trail[k]));
        ctx.stroke(); ctx.setLineDash([]);
      }
      if (o.boxes) {
        const cs = boxCorners(t).slice(0, 4);
        ctx.strokeStyle = col; ctx.lineWidth = t.id === o.selected ? 3 : 2;
        ctx.beginPath(); cs.forEach(([x, y], k) => k ? ctx.lineTo(toX(y), toY(x)) : ctx.moveTo(toX(y), toY(x))); ctx.closePath(); ctx.stroke();
        if (t.speed > 0.15) {                             // velocity arrow: where it will be in 1 s
          ctx.beginPath(); ctx.moveTo(toX(t.y), toY(t.x)); ctx.lineTo(toX(t.y + t.vy), toY(t.x + t.vx)); ctx.stroke();
        }
      }
      if (o.labels) {
        ctx.fillStyle = col;
        ctx.fillText(trackLabel(t), toX(t.y + t.box.dy) + Math.max(8, t.box.wid * this.top.scale / 2 + 6), toY(t.x + t.box.dx) + 4);
      }
    }
  }

  /** layer spacing in beam steps (angle-true cells), from the middle column's elevations */
  private aspectOf(d: View2DData): number {
    const { L, B, elev } = d.grid, mid = B >> 1, step = Math.abs(d.meta.step_deg);
    const a = Math.abs(elev[(L - 1) * B + mid] - elev[mid]) / Math.max(1, L - 1) / (step || 1);
    return isFinite(a) ? Math.min(20, Math.max(1, a)) : 1;
  }

  /** row height in CSS px: the cell width × aspect, in whole device pixels */
  private rowH(): number { return Math.max(this.img.cell, Math.round(this.img.cell * this.img.aspect * this.dpr) / this.dpr); }

  /** range-image row of layer l (0 = top) */
  private row(l: number, L: number, upsideDown: boolean): number { return upsideDown ? l : L - 1 - l; }

  private renderImage(d: View2DData): void {
    const ctx = this.ctx, { L, B, N, elev, rawIn } = d.grid, vis = d.geo.vis, C = d.geo.col, D = d.grid.out, up = d.upsideDown;
    if (this.off.width !== B || this.off.height !== L) { this.off.width = B; this.off.height = L; }
    const img = this.offCtx.createImageData(B, L), px = new Uint32Array(img.data.buffer);
    let lo = 0, hi = 1;
    if (d.byDistance) {                                    // uniform colouring would be blank: use distance
      const smp: number[] = [];
      for (let i = 0; i < N; i += 5) if (vis[i]) smp.push(D[i]);
      smp.sort((a, b) => a - b);
      if (smp.length) { lo = smp[Math.floor(smp.length * 0.02)]; hi = Math.max(lo + 0.1, smp[Math.floor(smp.length * 0.98)]); }
    }
    for (let l = 0; l < L; l++) for (let b = 0; b < B; b++) {
      const i = l * B + b, o = this.row(l, L, up) * B + (B - 1 - b);
      if (vis[i]) px[o] = packABGR(d.byDistance ? d.tint(i, turbo((D[i] - lo) / (hi - lo))) : [C[3 * i], C[3 * i + 1], C[3 * i + 2]]);
      else px[o] = rawIn[i] > 0 ? 0xffd84fff : 0xff3a342e;   // removed by filters (pink) : no return (grey)
    }
    this.offCtx.putImageData(img, 0, 0);
    const A = this.imgArea();
    if (!this.img.cell) this.fit();
    const { cell, ox, oy } = this.img, rh = this.rowH(), gw = B * cell, gh = L * rh;
    ctx.save();
    ctx.beginPath(); ctx.rect(A.left, A.top, A.w, A.h); ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.off, ox, oy, gw, gh);
    if (cell * this.dpr >= 8) {                            // zoomed in: faint cell borders
      const x0 = Math.max(0, Math.floor((A.left - ox) / cell)), x1 = Math.min(B, Math.ceil((A.left + A.w - ox) / cell));
      const y0 = Math.max(0, Math.floor((A.top - oy) / rh)), y1 = Math.min(L, Math.ceil((A.top + A.h - oy) / rh));
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) { ctx.moveTo(ox + x * cell, oy + y0 * rh); ctx.lineTo(ox + x * cell, oy + y1 * rh); }
      for (let y = y0; y <= y1; y++) { ctx.moveTo(ox + x0 * cell, oy + y * rh); ctx.lineTo(ox + x1 * cell, oy + y * rh); }
      ctx.strokeStyle = this.c.bg; ctx.globalAlpha = 0.35; ctx.lineWidth = 1 / this.dpr; ctx.stroke(); ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = this.c.border; ctx.lineWidth = 1; ctx.strokeRect(ox - 0.5, oy - 0.5, gw + 1, gh + 1);
    if (d.overlay.boxes || d.overlay.labels) {             // objects: outline of their beams/layers
      ctx.font = "12px system-ui"; ctx.textAlign = "left";
      for (const t of d.tracks) {
        if (!t.det) continue;
        const o = t.det, x = ox + (B - 1 - o.b1) * cell, y = oy + Math.min(this.row(o.l0, L, up), this.row(o.l1, L, up)) * rh;
        const sel = d.overlay.selected;
        ctx.strokeStyle = ctx.fillStyle = css(sel && t.id !== sel ? scale(t.color, 0.45) : t.color);
        ctx.lineWidth = t.id === sel ? 3 : 2;
        if (d.overlay.boxes) ctx.strokeRect(x - 1, y - 1, (o.b1 - o.b0 + 1) * cell + 2, (o.l1 - o.l0 + 1) * rh + 2);
        if (d.overlay.labels) ctx.fillText(trackLabel(t), x, Math.max(A.top + 12, y - 5));
      }
    }
    ctx.restore();
    // axes: azimuth under the grid, layer elevation on the left
    ctx.fillStyle = this.c.muted; ctx.font = "11px system-ui"; ctx.textAlign = "center";
    const az0 = d.meta.start_azimuth_deg, azStep = d.meta.step_deg;
    const tick = [0.5, 1, 2, 5, 10, 20, 30].find(t => t / azStep * cell >= 50) || 30;
    const axisY = Math.min(oy + gh, A.top + A.h);
    for (let a = Math.ceil(az0 / tick) * tick; a <= az0 + (B - 1) * azStep + 1e-9; a += tick) {
      const x = ox + (B - 1 - (a - az0) / azStep + 0.5) * cell;
      if (x < A.left || x > A.left + A.w) continue;
      ctx.fillRect(x, axisY, 1, 4); ctx.fillText(`${+a.toFixed(1)}°`, x, axisY + 16);
    }
    ctx.fillText("azimuth (left = sensor's left)", A.left + A.w / 2, axisY + 32);
    ctx.textAlign = "right";
    const every = Math.max(1, Math.ceil(14 / rh));
    for (let l = 0; l < L; l += every) {
      const y = oy + (this.row(l, L, up) + 0.5) * rh;
      if (y < A.top || y > A.top + A.h) continue;
      ctx.fillText(`${((up ? -1 : 1) * elev[l * B + (B >> 1)]).toFixed(1)}°`, A.left - 6, y + 4);   // world elevation
    }
    ctx.textAlign = "left";
    ctx.fillText(`cell ${(cell * this.dpr).toFixed(0)} × ${(rh * this.dpr).toFixed(0)} px (angle-true)` +
      (d.byDistance ? `  ·  colour: distance ${lo.toFixed(1)}–${hi.toFixed(1)} m (pick a colour mode to change)` : ""), A.left, A.top - 12);
  }

  /** grid index under the mouse, or -1 */
  private beamAt(mx: number, my: number): number {
    const d = this.cb.data();
    if (!d) return -1;
    if (this.mode === "top") {
      const P = d.geo.pos; let best = 64, i = -1;           // within 8 px
      for (let k = 0; k < d.geo.np; k++) {
        const j = d.geo.pIdx[k], dx = this.top.cx - P[3 * j + 1] * this.top.scale - mx, dy = this.top.cy - P[3 * j] * this.top.scale - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; i = j % d.grid.N; }        // remembered-wall vertices: N + beam
      }
      return i;
    }
    if (!this.img.cell) return -1;
    const A = this.imgArea(), cb = Math.floor((mx - this.img.ox) / this.img.cell), cl = Math.floor((my - this.img.oy) / this.rowH());
    if (mx >= A.left && mx < A.left + A.w && my >= A.top && my < A.top + A.h && cb >= 0 && cb < d.grid.B && cl >= 0 && cl < d.grid.L)
      return this.row(cl, d.grid.L, d.upsideDown) * d.grid.B + (d.grid.B - 1 - cb);   // row() is its own inverse
    return -1;
  }

  private pickTop(mx: number, my: number, tracks: Track[]): number {
    let best = 0, bd = 20;                                  // within 20 px of the box centre
    for (const t of tracks) {
      const dd = Math.hypot(this.top.cx - (t.y + t.box.dy) * this.top.scale - mx, this.top.cy - (t.x + t.box.dx) * this.top.scale - my);
      if (dd < bd + Math.max(t.box.len, t.box.wid) * this.top.scale / 2) { bd = dd; best = t.id; }
    }
    return best;
  }

  private click(e: PointerEvent): void {
    const down = this.downAt;
    this.drag = null; this.downAt = null;
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) >= 4) return;   // a drag, not a click
    const d = this.cb.data();
    let id = 0;
    if (d && this.mode === "top") id = this.pickTop(e.clientX, e.clientY, d.tracks);
    else { const i = this.beamAt(e.clientX, e.clientY); if (i >= 0) id = this.cb.objectAt(i); }
    this.cb.select(id);
  }

  private move(e: PointerEvent): void {
    if (this.drag) {
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (this.mode === "top") { this.top.cx += dx; this.top.cy += dy; } else { this.img.ox += dx; this.img.oy += dy; }
      this.drag = { x: e.clientX, y: e.clientY };
      this.tip.hidden = true; this.render();
      return;
    }
    const i = this.beamAt(e.clientX, e.clientY);
    if (i < 0) { this.tip.hidden = true; return; }
    this.tip.textContent = this.cb.describe(i);
    this.tip.hidden = false;
    this.tip.style.left = Math.min(e.clientX + 14, innerWidth - this.tip.offsetWidth - 8) + "px";
    this.tip.style.top = Math.min(e.clientY + 14, innerHeight - this.tip.offsetHeight - 8) + "px";
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    let f = Math.exp(-e.deltaY * 0.0015);
    if (this.mode === "top") {
      const t = this.top;
      t.cx = e.clientX - (e.clientX - t.cx) * f; t.cy = e.clientY - (e.clientY - t.cy) * f; t.scale *= f;
    } else if (this.img.cell) {
      // zoom in whole-device-pixel steps so cells stay crisp
      const snap = (c: number) => Math.max(1, Math.round(c * this.dpr)) / this.dpr;
      let c = snap(this.img.cell * f);
      if (c === this.img.cell) c = snap(this.img.cell + Math.sign(f - 1) / this.dpr);
      c = Math.min(80, Math.max(1 / this.dpr, c));
      f = c / this.img.cell;
      this.img.ox = e.clientX - (e.clientX - this.img.ox) * f; this.img.oy = e.clientY - (e.clientY - this.img.oy) * f; this.img.cell = c;
    }
    this.render();
  }
}
