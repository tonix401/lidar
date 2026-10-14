import { css } from "../core/colors";
import type { Track } from "../objects/tracker";
import { el } from "./dom";

export function objectRow(t: Track, selected: number, onSelect: (id: number) => void): HTMLDivElement {
  const meta = `${Math.hypot(t.x, t.y).toFixed(1)} m` + (t.speed > 0.15 ? ` · ${t.speed.toFixed(1)} m/s` : "") + (t.misses ? " · lost" : "");
  const row = el("div", { className: "orow" + (t.id === selected ? " sel" : ""), onclick: () => onSelect(t.id) },
    el("span", { className: "sw" }), el("span", { className: "nm", textContent: `#${t.id} ${t.cls}` }),
    el("span", { className: "mt", textContent: meta }));
  (row.firstChild as HTMLElement).style.background = css(t.color);
  return row;
}

/** object list (≤ 4 updates/s so rows stay clickable) */
export class ObjectsPanel {
  private at = 0;
  constructor(private info: HTMLElement, private list: HTMLElement, private onSelect: (id: number) => void) {}

  render(tracks: Track[], selected: number, infoText: string, force = false): void {
    const now = performance.now();
    if (!force && now - this.at < 250) return;
    this.at = now;
    this.info.textContent = infoText;
    this.list.replaceChildren(...[...tracks].sort((a, b) => a.id - b.id).map(t => objectRow(t, selected, this.onSelect)));
  }
}
