// Panel controls that only change something in some views: data-views="3d top" lists the views, and
// data-draw="points" / "mesh" needs a draw mode with points / with surface or lines.
import type { ViewMode } from "../config/config";
import { drawParts, type DrawMode } from "../render/scene3d";

export function relevant(e: HTMLElement, view: ViewMode, draw: DrawMode): boolean {
  const views = e.dataset.views, need = e.dataset.draw;
  if (views && !views.split(" ").includes(view)) return false;
  if (need === "points") return drawParts(draw).points;
  if (need === "mesh") return draw !== "points";
  return true;
}

/** hide (class offview, separate from the `hidden` that auto mode uses) what does nothing in this view */
export function applyViews(root: ParentNode, view: ViewMode, draw: DrawMode): void {
  for (const e of Array.from(root.querySelectorAll<HTMLElement>("[data-views], [data-draw]")))
    e.classList.toggle("offview", !relevant(e, view, draw));
}
