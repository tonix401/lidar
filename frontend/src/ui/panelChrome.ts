// The panel around the controls: boxes and sections that fold (remembered), the whole panel folding to its
// title bar, its width (drag the right edge; double-click: default), and the theme picker.
import { KEYS, type Store } from "../config/storage";
import { $ } from "./dom";
import { onSystemThemeChange, type Theme } from "./theme";

const PANEL_W: [number, number, number] = [240, 280, 640];       // min, default, max panel width (px)
/** status boxes start folded, sections open */
const FOLDS = [["streamBox", false], ["deviceBox", false], ["statsBox", false],
               ["secRec", true], ["secDisplay", true], ["secObjects", true], ["secProc", true]] as const;

export interface PanelChromeEvents {
  /** a box was unfolded (its contents may need a refresh) */
  opened(): void;
  /** the space left for the view changed; `refit`: the panel was shown or hidden */
  layout(refit: boolean): void;
  theme(t: Theme): void;
}

export class PanelChrome {
  constructor(private store: Store, private events: PanelChromeEvents) {
    for (const [id, openByDefault] of FOLDS) {
      const box = $<HTMLDetailsElement>(id), stored = store.get(KEYS.fold(id));
      box.open = stored === null ? openByDefault : stored === "1";
      box.ontoggle = () => { store.set(KEYS.fold(id), box.open ? "1" : "0"); if (box.open) events.opened(); };
    }
    this.show(store.get(KEYS.fold("panel")) !== "0");
    this.bindResize();
    const theme = $<HTMLSelectElement>("theme"), stored = store.get(KEYS.theme);
    theme.value = stored === "light" || stored === "system" ? stored : "dark";
    theme.onchange = () => { store.set(KEYS.theme, theme.value); events.theme(theme.value as Theme); };
    onSystemThemeChange(() => events.theme(theme.value as Theme));
    events.theme(theme.value as Theme);
    $("panelToggle").onclick = () => this.toggle();
  }

  get visible(): boolean { return !$("panel").classList.contains("min"); }

  /** fold or unfold the whole panel (H) */
  toggle(): void { this.show(!this.visible); }

  private show(show: boolean): void {
    $("panel").classList.toggle("min", !show);
    const t = $("panelToggle");
    t.textContent = show ? "‹" : "›"; t.title = show ? "hide the panel (H)" : "show the panel (H)";
    t.setAttribute("aria-expanded", String(show));
    this.store.set(KEYS.fold("panel"), show ? "1" : "0");
    this.events.layout(true);
  }

  private bindResize(): void {
    const handle = $("panelResize"), root = document.documentElement;
    const set = (w: number, save: boolean) => {
      const px = Math.round(Math.min(PANEL_W[2], Math.max(PANEL_W[0], w)));
      root.style.setProperty("--panel-w", px + "px");
      if (save) this.store.set(KEYS.panelWidth, String(px));
      this.events.layout(false);
    };
    const stored = Number(this.store.get(KEYS.panelWidth));
    if (stored) set(stored, false);
    handle.onpointerdown = e => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const x0 = e.clientX, w0 = $("panel").offsetWidth;
      handle.onpointermove = m => set(w0 + m.clientX - x0, false);
      handle.onpointerup = m => { handle.onpointermove = null; set(w0 + m.clientX - x0, true); };
    };
    handle.ondblclick = () => set(PANEL_W[1], true);
  }
}
