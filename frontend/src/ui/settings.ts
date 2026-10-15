// What the viewer shows (as opposed to how scans are processed, config/): view, colours, draw mode, object
// overlays, … Loaded from and saved to the per-browser Store; the controls change `UiSettings` in place.
import type { ViewMode } from "../config/config";
import { KEYS, type Store } from "../config/storage";
import type { Mount } from "../core/types";
import type { ColorBy } from "../render/geometry";
import type { DrawMode } from "../render/scene3d";

export const MAX_RANGE: [number, number] = [1, 250];
/** object overlay checkboxes in the panel → their setting */
export const OBJECT_TOGGLES = { oHighlight: "highlight", oDim: "dimBg", oBoxes: "boxes", oLabels: "labels", oTrails: "trails", oFollow: "follow" } as const;
type ObjectToggle = (typeof OBJECT_TOGGLES)[keyof typeof OBJECT_TOGGLES];

export interface UiSettings {
  colorBy: ColorBy; layer: number; maxRange: number; mount: Mount; paused: boolean; draw: DrawMode; pointSize: number;
  view: ViewMode; highlight: boolean; dimBg: boolean; boxes: boolean; labels: boolean; trails: boolean; follow: boolean;
  fillWalls: boolean;
}

export const defaultUi = (): UiSettings => ({
  colorBy: "dist", layer: -1, maxRange: 60, mount: "upright", paused: false, draw: "surface+points", pointSize: 1, view: "3d",
  highlight: true, dimBg: true, boxes: true, labels: true, trails: true, follow: false, fillWalls: true,
});

/** the stored settings; `mountChosen`: the user picked the mount (otherwise it follows the device / recording) */
export function loadUi(store: Store): { ui: UiSettings; mountChosen: boolean } {
  const ui = defaultUi();
  let mountChosen = false;
  const m = store.get(KEYS.mount);
  if (m === "upright" || m === "upsidedown") { ui.mount = m; mountChosen = true; }
  const v = store.get(KEYS.view);
  if (v === "3d" || v === "top" || v === "image") ui.view = v;
  if (store.get(KEYS.fillWalls) === "0") ui.fillWalls = false;
  const r = Number(store.get(KEYS.maxRange));
  if (r >= MAX_RANGE[0] && r <= MAX_RANGE[1]) ui.maxRange = r;
  for (const key of Object.values(OBJECT_TOGGLES)) {
    const s = store.get(KEYS.objectToggle(key));
    if (s !== null) ui[key] = s === "1";
  }
  return { ui, mountChosen };
}

/** remember one setting (only those listed here are remembered) */
export function saveUi(store: Store, ui: UiSettings, key: "mount" | "view" | "fillWalls" | "maxRange" | ObjectToggle): void {
  if (key === "mount") store.set(KEYS.mount, ui.mount);
  else if (key === "view") store.set(KEYS.view, ui.view);
  else if (key === "fillWalls") store.set(KEYS.fillWalls, ui.fillWalls ? "1" : "0");
  else if (key === "maxRange") store.set(KEYS.maxRange, String(ui.maxRange));
  else store.set(KEYS.objectToggle(key), ui[key] ? "1" : "0");
}
