// Live numbers (timings, noise, what the filters removed, object counts) in one place, grouped. Rows are
// kept and updated in place, so an open explanation (ⓘ) survives the ~10 updates per second.
import { el } from "./dom";
import { info } from "./info";

/** [label, value, explanation?]; a row left out of an update is hidden */
export type StatRow = [string, string, string?];

export class StatsPanel {
  private groups = new Map<string, { box: HTMLElement; rows: Map<string, HTMLElement> }>();

  constructor(host: HTMLElement, groups: string[]) {
    for (const g of groups) {
      const box = el("div", { className: "sgroup" }, el("div", { className: "sgtitle", textContent: g }));
      host.append(box);
      this.groups.set(g, { box, rows: new Map() });
    }
  }

  render(data: Record<string, StatRow[]>): void {
    for (const [name, g] of this.groups) {
      const rows = data[name] ?? [], shown = new Set<string>();
      for (const [label, value, tip] of rows) {
        let row = g.rows.get(label);
        if (!row) {
          row = el("div", { className: "row" }, el("span", { textContent: label }), el("span"));
          if (tip) (row.firstChild as HTMLElement).append(" ", info(tip));
          g.box.append(row); g.rows.set(label, row);
        }
        (row.lastChild as HTMLElement).textContent = value;
        shown.add(label);
      }
      for (const [label, row] of g.rows) row.hidden = !shown.has(label);
      g.box.hidden = !shown.size;
    }
  }
}
