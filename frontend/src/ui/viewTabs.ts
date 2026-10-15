// The view tabs (3D / 2D map / range image) with Pause for the live view, the 3D camera buttons, "fit" for
// the 2D views, and the keyboard shortcuts.
import type { ViewMode } from "../config/config";
import type { CameraView, DrawMode } from "../render/scene3d";
import { $ } from "./dom";
import { setInfo } from "./info";
import { applyViews } from "./views";

const CAMERAS: [string, CameraView][] = [["vPersp", "persp"], ["vTop", "top"], ["vSide", "side"], ["vFront", "front"]];
const HINTS: Record<ViewMode, string> = {
  "3d": "Mouse: drag rotates, right-drag pans, wheel zooms, click a label selects",
  top: "Mouse: drag pans, wheel zooms, double-click fits, hover inspects a point, click selects an object",
  image: "Mouse: drag pans, wheel zooms, double-click fits, hover inspects a beam, click selects an object. Grey = no return, " +
         "pink = removed by filters. Rows are as far apart as the layers in angle",
};

export interface ViewTabsEvents {
  view(v: ViewMode): void;
  camera(c: CameraView): void;
  fit2d(): void;
  pause(): void;
}

export class ViewTabs {
  constructor(events: ViewTabsEvents) {
    for (const b of this.buttons()) b.onclick = () => events.view(b.dataset.mode as ViewMode);
    for (const [id, c] of CAMERAS) $(id).onclick = () => events.camera(c);
    $("fit2d").onclick = () => events.fit2d();
    $("pause").onclick = () => events.pause();
  }

  /** Pause / Resume; hidden during a replay, where the replay bar has play/pause */
  showPause(paused: boolean, replaying: boolean): void {
    const b = $("pause");
    b.classList.toggle("on", paused);
    b.hidden = replaying;
    b.textContent = paused ? (replaying ? "Play" : "Resume") : "Pause";
  }

  /** show view v: its tab, its canvas, the panel controls that apply to it, and the mouse/keys hint */
  show(v: ViewMode, draw: DrawMode, replaying: boolean): void {
    for (const b of this.buttons()) b.classList.toggle("on", b.dataset.mode === v);
    $("view").hidden = v !== "3d"; $("view2d").hidden = v === "3d"; $("labels").hidden = v !== "3d";
    applyViews($("panel"), v, draw);
    const keys = " · keys: 1 / 2 / 3 switch views, H hides the panel, space pauses" + (replaying ? ", ← → step" : "");
    setInfo($("hint"), HINTS[v] + keys);
  }

  private buttons(): HTMLElement[] { return Array.from($("modeBtns").children) as HTMLElement[]; }
}

export interface KeyEvents {
  pause(): void;
  view(v: ViewMode): void;
  togglePanel(): void;
  /** ← / →: step the replay; false when not replaying (the key is then left alone) */
  step(dir: -1 | 1): boolean;
}

/** keyboard shortcuts, unless typing into a field */
export function bindKeys(events: KeyEvents, target: Window = window): void {
  target.addEventListener("keydown", e => {
    if (e.target !== document.body) return;
    if (e.code === "Space") { e.preventDefault(); events.pause(); }
    else if (e.key === "1" || e.key === "2" || e.key === "3") events.view((["3d", "top", "image"] as const)[+e.key - 1]);
    else if (e.key === "h" || e.key === "H") events.togglePanel();
    else if ((e.code === "ArrowLeft" || e.code === "ArrowRight") && events.step(e.code === "ArrowLeft" ? -1 : 1)) e.preventDefault();
  });
}
