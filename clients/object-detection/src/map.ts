// The floor map: the world from above (x right, y up, m), a 1 m grid, each sensor where the rig puts it with its 120°
// field of view, and each object as its box (turned by its yaw), a velocity arrow and its trail. Drag to pan, wheel
// to zoom; `pick` finds the object under the mouse.
import type { WorldObject } from "@mrs6000/wire/objects";
import type { Rig } from "@mrs6000/wire/rig";

const CLASS_COLOR: Record<string, string> = { person: "#4aa3ff", "moving object": "#d29922", object: "#a371f7", "static object": "#8b95a3" };
export const classColor = (c: string): string => CLASS_COLOR[c] ?? "#8b95a3";

const FOV_DEG = 120, FOV_RANGE_M = 8;

export class FloorMap {
  cx = 0; cy = 0; scale = 60;               // the world point at the centre, px per m
  private fitted = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    let drag: { x: number; y: number } | null = null;
    canvas.addEventListener("pointerdown", e => { if (e.button === 0 && !this.picking) { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); } });
    canvas.addEventListener("pointermove", e => {
      if (!drag) return;
      this.cx -= (e.clientX - drag.x) / this.scale; this.cy += (e.clientY - drag.y) / this.scale;
      drag = { x: e.clientX, y: e.clientY };
      this.onChange?.();
    });
    canvas.addEventListener("pointerup", () => { drag = null; });
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      const [wx, wy] = this.toWorld(e.offsetX, e.offsetY), f = Math.exp(-e.deltaY * 0.0015);
      this.scale = Math.max(5, Math.min(800, this.scale * f));
      const [nx, ny] = this.toWorld(e.offsetX, e.offsetY);
      this.cx += wx - nx; this.cy += wy - ny;
      this.onChange?.();
    }, { passive: false });
  }

  onChange: (() => void) | null = null;
  picking = false;                           // clicks add region points instead of panning

  toScreen(x: number, y: number): [number, number] {
    return [this.canvas.clientWidth / 2 + (x - this.cx) * this.scale, this.canvas.clientHeight / 2 - (y - this.cy) * this.scale];
  }

  toWorld(px: number, py: number): [number, number] {
    return [this.cx + (px - this.canvas.clientWidth / 2) / this.scale, this.cy - (py - this.canvas.clientHeight / 2) / this.scale];
  }

  /** centre the sensors once (or again when asked) */
  fit(rig: Rig, force = false): void {
    if (this.fitted && !force) return;
    const ps = rig.sensors.flatMap(s => (s.pose ? [[s.pose.x, s.pose.y]] : []));
    if (!ps.length) return;
    this.fitted = true;
    const xs = ps.map(p => p[0]), ys = ps.map(p => p[1]);
    this.cx = (Math.min(...xs) + Math.max(...xs)) / 2; this.cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) + 2 * FOV_RANGE_M * 0.6;
    this.scale = Math.min(this.canvas.clientWidth, this.canvas.clientHeight) / span;
  }

  pick(px: number, py: number, objects: WorldObject[]): WorldObject | null {
    const [x, y] = this.toWorld(px, py);
    let best: WorldObject | null = null, bd = 0.6;
    for (const o of objects) { const d = Math.hypot(o.x - x, o.y - y); if (d < bd) { bd = d; best = o; } }
    return best;
  }

  draw(rig: Rig, objects: WorldObject[], region: [number, number][], drafting: boolean, selected: number | null): void {
    const c = this.canvas, dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext("2d")!, cs = getComputedStyle(document.body), v = (n: string) => cs.getPropertyValue(n).trim();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    // grid
    const [x0, y1] = this.toWorld(0, 0), [x1, y0] = this.toWorld(W, H), step = this.scale < 15 ? 5 : 1;
    g.lineWidth = 1;
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) { const [px] = this.toScreen(x, 0); g.strokeStyle = v(x === 0 ? "--axis" : "--grid"); g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke(); }
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) { const [, py] = this.toScreen(0, y); g.strokeStyle = v(y === 0 ? "--axis" : "--grid"); g.beginPath(); g.moveTo(0, py); g.lineTo(W, py); g.stroke(); }
    // sensors and their fields of view
    for (const s of rig.sensors) {
      if (!s.pose) continue;
      const [px, py] = this.toScreen(s.pose.x, s.pose.y), a = -s.pose.yaw * Math.PI / 180, half = (FOV_DEG / 2) * Math.PI / 180;
      g.fillStyle = v("--fov"); g.beginPath(); g.moveTo(px, py); g.arc(px, py, FOV_RANGE_M * this.scale, a - half, a + half); g.closePath(); g.fill();
      g.fillStyle = v("--text"); g.beginPath(); g.arc(px, py, 4, 0, 2 * Math.PI); g.fill();
      g.font = "12px system-ui"; g.fillText(s.name, px + 7, py - 7);
    }
    // the region
    if (region.length) {
      g.strokeStyle = v("--accent"); g.setLineDash([5, 4]); g.lineWidth = 1.5; g.beginPath();
      region.forEach(([x, y], i) => { const [px, py] = this.toScreen(x, y); if (i) g.lineTo(px, py); else g.moveTo(px, py); });
      if (!drafting) g.closePath();
      g.stroke(); g.setLineDash([]);
    }
    // objects
    for (const o of objects) {
      const col = classColor(o.cls), [px, py] = this.toScreen(o.x, o.y);
      if (o.trail?.length) {
        g.strokeStyle = col; g.globalAlpha = 0.45; g.lineWidth = 2; g.beginPath();
        for (let i = 0; i + 1 < o.trail.length; i += 2) { const [tx, ty] = this.toScreen(o.trail[i], o.trail[i + 1]); if (i) g.lineTo(tx, ty); else g.moveTo(tx, ty); }
        g.lineTo(px, py); g.stroke(); g.globalAlpha = 1;
      }
      g.save(); g.translate(px, py); g.rotate(-o.box.yaw * Math.PI / 180);
      const L = Math.max(o.box.len * this.scale, 4), Wd = Math.max(o.box.wid * this.scale, 4);
      g.fillStyle = col; g.globalAlpha = o.id === selected ? 0.55 : 0.3; g.fillRect(-L / 2, -Wd / 2, L, Wd); g.globalAlpha = 1;
      g.strokeStyle = col; g.lineWidth = o.id === selected ? 2.5 : 1.5; g.strokeRect(-L / 2, -Wd / 2, L, Wd);
      g.restore();
      if (o.speed > 0.1) {
        const [ax, ay] = this.toScreen(o.x + o.vx, o.y + o.vy);
        g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); g.moveTo(px, py); g.lineTo(ax, ay); g.stroke();
        const h = Math.atan2(ay - py, ax - px);
        g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax - 7 * Math.cos(h - 0.4), ay - 7 * Math.sin(h - 0.4)); g.lineTo(ax - 7 * Math.cos(h + 0.4), ay - 7 * Math.sin(h + 0.4)); g.closePath();
        g.fillStyle = col; g.fill();
      }
      g.fillStyle = v("--text"); g.font = "11px system-ui"; g.fillText(`#${o.id}`, px + 6, py + 14);
    }
  }
}
