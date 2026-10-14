// Wires the pieces together: frame stream → Processor → Geometry → 3D/2D views, plus the panel.
import { Api, type Frame } from "./api/client";
import { FrameStream } from "./api/stream";
import { autoConfig, estimateNoise, type NoiseEstimate } from "./config/auto";
import { DEFAULT_ADAPTIVE, DEFAULT_INTENSITY, DEFAULT_LAYERCAL, DEFAULT_OBJECTS, DEFAULT_WALLS, defaultConfig, matchingPreset, mergeConfig,
         USER_STAGES, USER_TOGGLES, withPreset, type Config, type PresetName, type StageKey, type ViewMode } from "./config/config";
import { KEYS, Store } from "./config/storage";
import { turboGradientCss } from "./core/colors";
import { popcount } from "./core/math";
import type { Mount, RGB, ServerState } from "./core/types";
import { historyMask } from "./pipeline/history";
import { Processor } from "./pipeline/processor";
import { trackLabel } from "./objects/tracker";
import { buildGeometry, createGeometry, type ColorBy, type Geometry } from "./render/geometry";
import { drawParts, Scene3D, type CameraView, type DrawMode } from "./render/scene3d";
import { View2D, type View2DData } from "./render/view2d";
import { drawHistogram, drawLayerBias } from "./ui/charts";
import { deviceSummary, renderDevice } from "./ui/devicePanel";
import { $ } from "./ui/dom";
import { bindInfoIcons, setInfo } from "./ui/info";
import { applyTheme, hexRGB, onSystemThemeChange, themeColors, type Theme } from "./ui/theme";
import { ObjectsPanel } from "./ui/objectsPanel";
import { Problems } from "./ui/problems";
import { RecordingPanel } from "./ui/recordingPanel";
import { StageControls } from "./ui/stageControls";
import { StatsPanel, type StatRow } from "./ui/statsPanel";
import { applyViews } from "./ui/views";

type Mode = "auto" | "manual";
const MAX_RANGE: [number, number] = [1, 250];
const PANEL_W: [number, number, number] = [240, 280, 640];       // min, default, max panel width (px)
const OBJECT_TOGGLES = { oHighlight: "highlight", oDim: "dimBg", oBoxes: "boxes", oLabels: "labels", oTrails: "trails", oFollow: "follow" } as const;

export class App {
  readonly api = new Api();
  readonly store = new Store();
  readonly problems = new Problems(lines => { $("err").textContent = lines.join("\n"); });
  ui = { colorBy: "dist" as ColorBy, layer: -1, maxRange: 60, mount: "upright" as Mount, paused: false, draw: "surface+points" as DrawMode,
         pointSize: 1, view: "3d" as ViewMode, highlight: true, dimBg: true, boxes: true, labels: true, trails: true, follow: false,
         fillWalls: true };
  mode: Mode = "auto";
  manualCfg: Config = defaultConfig();
  cfg: Config;
  processor: Processor;
  geo: Geometry | null = null;
  selected = 0;
  private mountChosen = false;
  private autoEst: NoiseEstimate | null = null;
  private rendersPerSec = NaN;
  private autoNoise = 0.02;
  private scansSeen = 0;
  private lastEpoch: number | null = null;
  private viewDist = 0;
  private lastFrameAt = 0;
  private streamText = "–";
  private dimTo: RGB | undefined;
  private listDirty = false;
  private srv: ServerState | null = null;
  private scene: Scene3D;
  private view2d: View2D;
  private stages: StageControls;
  private objectsPanel: ObjectsPanel;
  private recording: RecordingPanel;
  private statsPanel = new StatsPanel($("statsList"), ["Timing", "Scene", "Removed by filters", "Moving areas (people)", "Objects"]);
  private stream: FrameStream;

  constructor() {
    this.loadSettings();
    bindInfoIcons();
    this.cfg = this.mode === "auto" ? autoConfig(this.manualCfg, this.autoNoise) : structuredClone(this.manualCfg);
    this.processor = new Processor(this.cfg, this.ui.mount);
    const bias = this.store.json<number[]>(KEYS.layerBias);
    if (Array.isArray(bias)) this.processor.setLayerBias(bias);
    this.processor.onLayerBias = b => { this.store.setJson(KEYS.layerBias, Array.from(b)); this.drawCharts(); };

    this.scene = new Scene3D($("view"), $("labels"), id => this.select(id));
    this.view2d = new View2D($<HTMLCanvasElement>("view2d"), $("tip"), {
      data: () => this.view2dData(),
      describe: i => this.describe(i),
      objectAt: i => { const t = this.processor.objects?.tracker.byId(this.processor.objects.cell[i]); return t?.confirmed ? t.id : 0; },
      select: id => this.select(id),
      panelWidth: () => (innerWidth > 600 && !$("panel").classList.contains("min") ? $("panel").offsetWidth + 24 : 0),
      bottomInset: () => ($("transport").hidden ? 0 : 76),
      viewDist: () => this.viewDist,
    });
    this.stages = new StageControls({ default: $("stages"), objects: $("objStage"), display: $("meshStage") }, {
      change: (k, p, v) => this.changeParam(k, p, v),
      resetStage: k => { this.setCfg({ ...this.cfg, [k]: structuredClone(defaultConfig()[k]) }); this.changed(); },
      resetCalibration: () => { this.processor.layerBias.fill(0); this.store.setJson(KEYS.layerBias, Array.from(this.processor.layerBias)); this.processor.reset(); this.drawCharts(); },
      extraOpened: () => this.drawCharts(),
    });
    this.objectsPanel = new ObjectsPanel($("objInfo"), $("objList"), id => this.select(id));
    this.recording = new RecordingPanel(this.api, {
      state: s => this.applyState(s), error: e => this.problems.flash("action", e), confirm: msg => window.confirm(msg),
    });
    this.stream = new FrameStream(this.api, f => this.onFrame(f), this.problems.for("server"));
    this.bindControls();
    this.syncControls();
    this.scene.buildGuides(Math.min(this.ui.maxRange, 200), [-13.19, 1.19], this.ui.mount);
    this.scene.setDraw(this.ui.draw);
    this.scene.setView("persp", this.ui.maxRange);
    this.setView(this.ui.view);
  }

  start(): void {
    void this.stream.run();
    void this.pollStatus();
    void this.pollState();
    requestAnimationFrame(t => this.animate(t));
  }

  // ---------- settings ----------
  private loadSettings(): void {
    const saved = this.store.json<{ mode?: string; manual?: unknown }>(KEYS.smoothing);
    if (saved) {
      if (saved.mode === "auto" || saved.mode === "manual") this.mode = saved.mode;
      this.manualCfg = mergeConfig(defaultConfig(), saved.manual);
    }
    const m = this.store.get(KEYS.mount);
    if (m === "upright" || m === "upsidedown") { this.ui.mount = m; this.mountChosen = true; }
    const v = this.store.get(KEYS.view);
    if (v === "3d" || v === "top" || v === "image") this.ui.view = v;
    if (this.store.get(KEYS.fillWalls) === "0") this.ui.fillWalls = false;
    const r = Number(this.store.get(KEYS.maxRange));
    if (r >= MAX_RANGE[0] && r <= MAX_RANGE[1]) this.ui.maxRange = r;
    for (const key of Object.values(OBJECT_TOGGLES)) {
      const s = this.store.get(KEYS.objectToggle(key));
      if (s !== null) this.ui[key] = s === "1";
    }
  }

  private saveSettings(): void { this.store.setJson(KEYS.smoothing, { mode: this.mode, manual: this.manualCfg }); }

  private setCfg(cfg: Config): void {
    this.cfg = cfg;
    this.processor.cfg = cfg;
  }

  private changeParam(key: StageKey, param: string, value: number | boolean): void {
    const c = structuredClone(this.cfg);
    (c[key] as Record<string, number | boolean>)[param] = value;
    if (key === "intensity") {                               // keep min ≤ max
      if (param === "min" && c.intensity.max < c.intensity.min) c.intensity.max = c.intensity.min;
      if (param === "max" && c.intensity.min > c.intensity.max) c.intensity.min = c.intensity.max;
    }
    this.setCfg(c);
    this.changed();
  }

  /** after any settings change: remember, refresh controls, re-run the spatial stages */
  private changed(): void {
    if (this.mode === "manual") this.manualCfg = structuredClone(this.cfg);
    else {
      for (const k of USER_STAGES) (this.manualCfg as unknown as Record<string, unknown>)[k] = structuredClone(this.cfg[k]);
      for (const k of USER_TOGGLES) (this.manualCfg[k] as { on: boolean }).on = (this.cfg[k] as { on: boolean }).on;
    }
    if (!this.cfg.objects.on) this.processor.objects?.reset();
    this.saveSettings();
    this.syncControls();
    this.rebuild();
  }

  private applyPreset(name: PresetName): void {
    this.setCfg(withPreset(this.cfg, name));
    this.processor.reset();
    this.changed();
  }

  private syncControls(): void {
    const auto = this.mode === "auto";
    this.stages.sync(this.cfg, auto);
    $<HTMLSelectElement>("mode").value = this.mode;
    const preset = $<HTMLSelectElement>("preset");
    preset.value = matchingPreset(this.cfg);
    preset.closest(".row")!.toggleAttribute("hidden", auto);
    $("resetCfg").hidden = auto;
    setInfo($("autoInfo"), auto ? (this.autoEst ? "" : "Still learning the scene. ") +
      "Auto: the filter settings follow the measured noise and motion (see Statistics) and update every second. Intensity filter, " +
      "radial cells, remembered walls, object detection and the on/off of clean outlines stay yours. Switch to manual to see and edit everything."
      : "Manual: every stage and parameter is yours; the preset sets the smoothing stages at once ('off' = raw ranges).");
    $("fillWalls").closest(".row")!.toggleAttribute("hidden", !this.cfg.walls.on);
    this.drawCharts();
  }

  private drawCharts(): void {
    if (this.stages.histogram && this.stages.isOpen("histogram")) drawHistogram(this.stages.histogram, this.processor.rssiHist, this.cfg.intensity);
    if (this.stages.layerBias && this.stages.isOpen("layerbias")) drawLayerBias(this.stages.layerBias, this.processor.layerBias);
  }

  private bindControls(): void {
    $<HTMLSelectElement>("mode").onchange = e => {
      this.mode = (e.target as HTMLSelectElement).value as Mode;
      this.setCfg(this.mode === "auto" ? autoConfig(this.manualCfg, this.autoNoise) : structuredClone(this.manualCfg));
      this.changed();
    };
    $<HTMLSelectElement>("preset").onchange = e => this.applyPreset((e.target as HTMLSelectElement).value as PresetName);
    $("resetCfg").onclick = () => {
      this.setCfg({ ...this.cfg, intensity: { ...DEFAULT_INTENSITY }, layercal: { ...DEFAULT_LAYERCAL }, adaptive: { ...DEFAULT_ADAPTIVE }, objects: { ...DEFAULT_OBJECTS }, walls: { ...DEFAULT_WALLS } });
      this.applyPreset("medium");
    };
    const sel = (id: string, apply: (v: string) => void, value: string) => {
      const s = $<HTMLSelectElement>(id); s.value = value;
      s.onchange = () => { apply(s.value); this.rebuild(); };
    };
    sel("draw", v => { this.ui.draw = v as DrawMode; this.scene.setDraw(this.ui.draw); applyViews($("panel"), this.ui.view, this.ui.draw); }, this.ui.draw);
    sel("colorBy", v => { this.ui.colorBy = v as ColorBy; $("legendBox").classList.toggle("hidden", v === "uniform"); }, this.ui.colorBy);
    sel("layerSel", v => { this.ui.layer = +v; }, "-1");
    sel("mount", v => { this.setMount(v as Mount, true); }, this.ui.mount);
    $("legendBox").classList.toggle("hidden", this.ui.colorBy === "uniform");
    $("legend").style.background = turboGradientCss();
    const fill = $<HTMLInputElement>("fillWalls");
    fill.checked = this.ui.fillWalls;
    fill.onchange = () => { this.ui.fillWalls = fill.checked; this.store.set(KEYS.fillWalls, fill.checked ? "1" : "0"); this.rebuild(false); };
    const size = $<HTMLInputElement>("size");
    size.oninput = () => {
      this.ui.pointSize = +size.value; $("sizeVal").textContent = `${this.ui.pointSize} px`;
      this.scene.setPointSize(this.ui.pointSize); this.view2d.render();
    };
    const range = $<HTMLInputElement>("range");
    range.value = String(this.ui.maxRange);
    range.onchange = () => {                                  // Enter or leaving the field
      const v = range.valueAsNumber;
      if (!isFinite(v)) { range.value = String(this.ui.maxRange); return; }
      this.ui.maxRange = Math.min(MAX_RANGE[1], Math.max(MAX_RANGE[0], v));
      range.value = String(this.ui.maxRange);
      this.store.set(KEYS.maxRange, range.value);
      this.buildGuides(); this.rebuild();
    };
    range.onkeydown = e => { if (e.key === "Enter") range.blur(); };
    // every box and section folds on its own, remembered; status boxes start folded, sections open
    for (const [id, openByDefault] of [["streamBox", false], ["deviceBox", false], ["statsBox", false],
                                       ["secRec", true], ["secDisplay", true], ["secObjects", true], ["secProc", true]] as const) {
      const box = $<HTMLDetailsElement>(id), stored = this.store.get(KEYS.fold(id));
      box.open = stored === null ? openByDefault : stored === "1";
      box.ontoggle = () => { this.store.set(KEYS.fold(id), box.open ? "1" : "0"); if (box.open) this.panelStats(); };
    }
    this.showPanel(this.store.get(KEYS.fold("panel")) !== "0");
    this.bindPanelResize();
    const theme = $<HTMLSelectElement>("theme"), stored = this.store.get(KEYS.theme);
    theme.value = stored === "light" || stored === "system" ? stored : "dark";
    theme.onchange = () => { this.store.set(KEYS.theme, theme.value); this.setTheme(theme.value as Theme); };
    onSystemThemeChange(() => this.setTheme(theme.value as Theme));
    this.setTheme(theme.value as Theme);
    $("panelToggle").onclick = () => this.showPanel($("panel").classList.contains("min"));
    for (const [id, key] of Object.entries(OBJECT_TOGGLES)) {
      const cb = $<HTMLInputElement>(id);
      cb.checked = this.ui[key];
      cb.onchange = () => { this.ui[key] = cb.checked; this.store.set(KEYS.objectToggle(key), cb.checked ? "1" : "0"); this.syncDim(); this.rebuild(); };
    }
    this.syncDim();
    for (const b of Array.from($("modeBtns").children) as HTMLElement[]) b.onclick = () => this.setView(b.dataset.mode as ViewMode);
    const cams: [string, CameraView][] = [["vPersp", "persp"], ["vTop", "top"], ["vSide", "side"], ["vFront", "front"]];
    for (const [id, v] of cams) $(id).onclick = () => this.scene.setView(v, this.viewDist || this.ui.maxRange);
    $("fit2d").onclick = () => { this.view2d.fit(); this.view2d.render(); };
    $("pause").onclick = () => this.togglePause();
    window.addEventListener("keydown", e => {
      if (e.target !== document.body) return;
      if (e.code === "Space") { e.preventDefault(); this.togglePause(); }
      else if (e.key === "1" || e.key === "2" || e.key === "3") this.setView((["3d", "top", "image"] as const)[+e.key - 1]);
      else if (e.key === "h" || e.key === "H") this.showPanel($("panel").classList.contains("min"));
      else if (this.recording.replaying && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
        e.preventDefault();
        this.recording.control("step", e.code === "ArrowLeft" ? -1 : 1).then(s => this.applyState(s)).catch(err => this.problems.flash("action", err));
      }
    });
  }

  /** "dim background" only does something with highlighting on */
  private syncDim(): void {
    const dim = $<HTMLInputElement>("oDim");
    dim.disabled = !this.ui.highlight;
    dim.parentElement!.classList.toggle("disabled", dim.disabled);
  }

  private setTheme(t: Theme): void {
    applyTheme(t);
    const c = themeColors(), bg = hexRGB(c.bg);
    this.dimTo = bg && bg[0] + bg[1] + bg[2] > 1.5 ? bg : undefined;   // light background: fade towards it, not to black
    this.rebuild(false);
    this.scene.setTheme(c); this.buildGuides();
    this.view2d.setTheme(c);
    this.drawCharts();
  }

  /** drag the panel's right edge to resize it (remembered; double-click: default width) */
  private bindPanelResize(): void {
    const handle = $("panelResize"), root = document.documentElement;
    const set = (w: number, save: boolean) => {
      const px = Math.round(Math.min(PANEL_W[2], Math.max(PANEL_W[0], w)));
      root.style.setProperty("--panel-w", px + "px");
      if (save) this.store.set(KEYS.panelWidth, String(px));
      if (this.ui.view !== "3d") this.view2d.render();
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

  /** the whole panel folds to its title bar (H), so the view gets the screen */
  private showPanel(show: boolean): void {
    $("panel").classList.toggle("min", !show);
    const t = $("panelToggle");
    t.textContent = show ? "‹" : "›"; t.title = show ? "hide the panel (H)" : "show the panel (H)";
    t.setAttribute("aria-expanded", String(show));
    this.store.set(KEYS.fold("panel"), show ? "1" : "0");
    if (this.ui.view !== "3d") { this.view2d.fit(); this.view2d.render(); }
  }

  private setMount(m: Mount, chosen: boolean): void {
    if (chosen) { this.mountChosen = true; this.store.set(KEYS.mount, m); }
    this.ui.mount = m;
    $<HTMLSelectElement>("mount").value = m;
    this.processor.setMount(m);
    this.buildGuides();
    this.rebuild();
  }

  private buildGuides(): void {
    const g = this.processor.grid;
    const fan: [number, number] = g ? [g.elev[g.B >> 1], g.elev[(g.L - 1) * g.B + (g.B >> 1)]] : [-13.19, 1.19];
    this.scene.buildGuides(Math.min(this.ui.maxRange, 200), fan, this.ui.mount);
  }

  private setView(v: ViewMode): void {
    this.ui.view = v;
    for (const b of Array.from($("modeBtns").children) as HTMLElement[]) b.classList.toggle("on", b.dataset.mode === v);
    $("view").hidden = v !== "3d"; $("view2d").hidden = v === "3d"; $("labels").hidden = v !== "3d";
    applyViews($("panel"), v, this.ui.draw);
    const keys = " · keys: 1 / 2 / 3 switch views, H hides the panel, space pauses" + (this.recording?.replaying ? ", ← → step" : "");
    setInfo($("hint"), (v === "3d" ? "Mouse: drag rotates, right-drag pans, wheel zooms, click a label selects"
      : v === "top" ? "Mouse: drag pans, wheel zooms, double-click fits, hover inspects a point, click selects an object"
      : "Mouse: drag pans, wheel zooms, double-click fits, hover inspects a beam, click selects an object. Grey = no return, pink = removed by filters. Rows are as far apart as the layers in angle") + keys);
    this.store.set(KEYS.view, v);
    this.rebuild(false);                                      // the range image ignores the layer and range filters
    if (v === "3d") this.scene.resize(); else this.view2d.setMode(v);
  }

  private togglePause(): void {
    if (this.recording.replaying) {
      this.recording.control("toggle").then(s => this.applyState(s)).catch(e => this.problems.flash("action", e));
      return;
    }
    this.ui.paused = !this.ui.paused;
    this.showPause();
  }

  private showPause(): void {
    const replay = this.recording.replaying, paused = replay ? !this.recording.playing : this.ui.paused;
    $("pause").classList.toggle("on", paused);
    $("pause").hidden = replay;                               // the replay bar has its own play/pause
    $("pause").textContent = paused ? (replay ? "Play" : "Resume") : "Pause";
  }

  private select(id: number): void {
    this.selected = id === 0 || id === this.selected ? 0 : id;
    this.listDirty = true;                                    // show the selection at once (list is throttled)
    this.rebuild();
  }

  // ---------- frames ----------
  private onFrame({ meta, data }: Frame): void {
    this.lastFrameAt = performance.now();
    $("rate").textContent = meta.rate.toFixed(1) + " Hz";
    $("points").textContent = meta.points.toLocaleString();
    $("geom").textContent = `${meta.layers} × ${meta.beams}`;
    this.streamText = `${meta.layers}×${meta.beams} @ ${meta.rate.toFixed(1)} Hz`;
    // the server bumps `epoch` whenever the sequence jumps (seek, step back, loop, source switch):
    // per-beam histories and tracks from before the jump would be wrong, so start afresh
    if (meta.epoch !== undefined && meta.epoch !== this.lastEpoch) {
      if (this.lastEpoch !== null) this.processor.reset();
      this.lastEpoch = meta.epoch;
    }
    if (meta.source === "replay" && meta.replay) {
      $("subtitle").textContent = $("subtitle").title = `replaying ${meta.replay.file}`;
      this.recording.transport(meta.replay);
      const ud = meta.replay.upside_down;
      if (!this.mountChosen && typeof ud === "boolean" && (ud ? "upsidedown" : "upright") !== this.ui.mount) this.setMount(ud ? "upsidedown" : "upright", false);
    }
    if (this.ui.paused && meta.source !== "replay") return;
    try {
      const first = !this.processor.grid;
      const g = this.processor.ingest(data, meta);
      if (!this.geo || this.geo.N !== g.N) {
        this.geo = createGeometry(g.N);
        this.scene.bind(this.geo);
        $("layerSel").replaceChildren(new Option("all", "-1"), ...Array.from({ length: g.L }, (_, i) => new Option(String(i), String(i))));
      }
      if (this.mode === "auto" && ++this.scansSeen % 10 === 0) this.autoTune();
      if (first || !this.viewDist) {                            // first scan: frame the scene
        this.buildGuides();
        const s: number[] = [];
        for (let i = 0; i < g.N; i += 7) if (g.raw[i] > 0) s.push(g.raw[i]);
        s.sort((a, b) => a - b);
        if (s.length) {
          this.viewDist = s[Math.floor(s.length * 0.9)];
          this.scene.setView("persp", this.viewDist);
          if (this.ui.view !== "3d") this.view2d.fit();
        }
      }
      this.rebuild(false);
      this.problems.ok("processing");
    } catch (e) {
      this.problems.fail("processing", e);                    // a bad frame must not stop the stream
    }
  }

  private autoTune(): void {
    const g = this.processor.grid;
    const est = g ? estimateNoise(g) : null;
    if (est) {
      this.autoNoise = est.noise;
      this.autoEst = est;
    }
    const c = autoConfig(this.manualCfg, this.autoNoise);
    for (const k of USER_STAGES) (c as unknown as Record<string, unknown>)[k] = this.cfg[k];
    this.setCfg(c);
    this.syncControls();
  }

  /** re-run spatial stages (unless just done by ingest) and redraw everything */
  rebuild(refine = true): void {
    const g = this.processor.grid;
    if (!g || !this.geo) return;
    if (refine) this.processor.refine();
    const objects = this.processor.objects, highlight = this.cfg.objects.on && this.ui.highlight;
    const tintOpts = { selected: this.selected, dimBackground: this.ui.dimBg, dimTo: this.dimTo };
    const image = this.ui.view === "image";                  // every beam has its cell there
    buildGeometry(g, g.out, this.geo, {
      colorBy: this.ui.colorBy, layer: image ? -1 : this.ui.layer, maxRange: image ? Infinity : this.ui.maxRange, jump: this.cfg.mesh.jump, jumpRel: this.cfg.mesh.jumpRel,
      tint: highlight && objects ? (i, rgb) => objects.tint(i, rgb, tintOpts) : undefined,
      cells: this.processor.cells?.assign,
      fill: this.ui.fillWalls ? g.fill : null,
      fillTint: highlight && objects ? rgb => objects.tintBackground(rgb, tintOpts) : undefined,
      front: this.cfg.outline.on ? g.front : null,
      seesWall: this.cfg.outline.on ? g.seesWall : null,
    });
    this.scene.update(this.geo);
    if (this.selected && !objects?.tracker.byId(this.selected)) this.selected = 0;
    const tracks = this.visibleTracks();
    this.scene.setOverlays(tracks, { boxes: this.ui.boxes, trails: this.ui.trails, labels: this.ui.labels, selected: this.selected });
    if (this.ui.view !== "3d") this.view2d.render();
    this.objectsPanel.render(tracks, this.selected, !this.cfg.objects.on ? "object detection is off"
      : !objects?.bgModel.ready ? "learning the empty scene…" : tracks.length ? "" : "no objects", this.listDirty);
    $("objCount").textContent = tracks.length ? String(tracks.length) : "";
    this.listDirty = false;
    this.panelStats();
  }

  private visibleTracks() { return this.cfg.objects.on ? this.processor.objects?.confirmed ?? [] : []; }

  private panelStats(): void {
    const geo = this.geo, st = this.processor.stats;
    if (!geo) return;
    $("sumStats").textContent = `${(st.ingestMs + st.refineMs).toFixed(0)} ms per scan`;
    if ($<HTMLDetailsElement>("statsBox").open) this.statsPanel.render(this.statRows());
    const isArea = this.ui.colorBy === "area", isCell = this.ui.colorBy === "cell";
    $("legend").style.visibility = isArea || isCell ? "hidden" : "";
    if (isArea) {
      const [f, d, m] = geo.areaCounts;
      $("legMin").textContent = `flat ${f} · detail ${d}`; $("legMax").textContent = `moving ${m}`;
    } else if (isCell) {
      $("legMin").textContent = this.cfg.cells.on ? "one colour per depth slot" : "radial cells are off"; $("legMax").textContent = "grey: none";
    } else {
      const unit = { rssi: "", dist: " m", height: " m", layer: "", uniform: "", noise: " mm", conf: "", area: "", cell: "" }[this.ui.colorBy];
      const fmt = (v: number) => this.ui.colorBy === "dist" || this.ui.colorBy === "height" ? v.toFixed(1) : this.ui.colorBy === "conf" ? v.toFixed(2) : String(Math.round(v));
      $("legMin").textContent = fmt(geo.lo) + unit; $("legMax").textContent = fmt(geo.hi) + unit;
    }
    this.drawCharts();
  }

  /** the Statistics box, grouped */
  private statRows(): Record<string, StatRow[]> {
    const st = this.processor.stats, c = this.cfg, objects = this.processor.objects, est = this.autoEst;
    const n = (v: number) => v.toLocaleString();
    const timing: StatRow[] = [["Processing", (st.ingestMs + st.refineMs).toFixed(0) + " ms", "filters, smoothing and objects for one scan"]];
    if (this.ui.view === "3d") timing.push(["Renders / s", isNaN(this.rendersPerSec) ? "–" : String(this.rendersPerSec), "3D renders on demand: ≈ scan rate with a still camera"]);
    if (this.ui.view === "3d" && drawParts(this.ui.draw).surface) timing.push(["Triangles", n(this.geo!.nt)]);
    const scene: StatRow[] = this.mode === "auto" && est ? [
      ["Noise floor", `${Math.round(est.noise * 1000)} mm`, `median noise σ of ${n(est.samples)} steady beams; auto mode derives its tolerances from it (change gate 3σ)`],
      ["Moving beams", `${(100 * est.movingShare).toFixed(1)} %`]] : [];
    const removed = ([["Intensity filter", c.intensity.on, st.intensity], ["Outliers", c.outlier.on, st.outliers], ["Flicker", c.history.on, st.flicker],
      ["Mixed pixels", c.dynamic.on, st.veils], ["Spikes (radial cells)", c.cells.on, st.spikes], ["At outlines", c.outline.on, st.mixed]] as const)
      .filter(([, on]) => on).map(([k, , v]): StatRow => [k, n(v)]);
    const moving: StatRow[] = isNaN(st.movRough) ? [] : [
      ["Roughness", st.movRough.toFixed(1) + " mm", "median deviation of a moving beam from its same-surface neighbours; lower is cleaner"],
      ...(isNaN(st.movFlicker) ? [] : [["Flicker", (st.movFlicker * 100).toFixed(0) + " %", "share of moving beams that switched between object and background since the last scan; lower is cleaner"] as StatRow])];
    const conf = this.visibleTracks(), people = conf.filter(t => t.cls === "person").length;
    const obj: StatRow[] = c.objects.on && objects?.bgModel.ready ? [
      ["Objects", `${conf.length} (${people} ${people === 1 ? "person" : "people"})`],
      ["Foreground beams", n(objects.foregroundCount), "returns clearly in front of the learned empty scene"],
      ["Detection time", objects.lastMs.toFixed(1) + " ms"]] : [];
    return { "Timing": timing, "Scene": scene, "Removed by filters": removed, "Moving areas (people)": moving, "Objects": obj };
  }

  private view2dData(): View2DData | null {
    const g = this.processor.grid, meta = this.processor.meta, objects = this.processor.objects;
    if (!g || !meta || !this.geo) return null;
    const highlight = this.cfg.objects.on && this.ui.highlight && objects;
    const opts = { selected: this.selected, dimBackground: this.ui.dimBg, dimTo: this.dimTo };
    return {
      grid: g, geo: this.geo, meta, tracks: this.visibleTracks(), draw: this.ui.draw, pointSize: this.ui.pointSize, maxRange: this.ui.maxRange,
      overlay: { boxes: this.ui.boxes, labels: this.ui.labels, trails: this.ui.trails, selected: this.selected },
      byDistance: this.ui.colorBy === "uniform",
      upsideDown: this.ui.mount === "upsidedown",
      tint: highlight ? (i, rgb) => objects!.tint(i, rgb, opts) : (_i, rgb) => rgb,
      follow: this.ui.follow ? objects?.tracker.byId(this.selected) : undefined,
    };
  }

  /** tooltip for beam i in the 2D views */
  describe(i: number): string {
    const g = this.processor.grid!, meta = this.processor.meta!, objects = this.processor.objects;
    const l = Math.floor(i / g.B), b = i % g.B;
    const valid = popcount(g.validBits[i] & historyMask(g.frames)) / Math.max(1, g.frames);
    const t = objects?.tracker.byId(objects.cell[i]);
    const bg = objects?.bgModel.bg[i] ?? 0;
    const status = (this.geo?.vis[i] ? "" : g.rawIn[i] > 0 ? "\nremoved by filters" : "\nno return") +
      (t?.confirmed ? `\nobject ${trackLabel(t)}` : "") + (bg > 0 ? `\nempty-scene range ${bg.toFixed(2)} m` : "");
    return `layer ${l}  ·  beam ${b}\n` +
      `azimuth ${(meta.start_azimuth_deg + b * meta.step_deg).toFixed(2)}°  elevation ${((this.ui.mount === "upsidedown" ? -1 : 1) * g.elev[i]).toFixed(2)}°\n` +
      `distance ${g.out[i] > 0 ? g.out[i].toFixed(3) + " m" : "–"}  (raw ${g.rawIn[i] > 0 ? g.rawIn[i].toFixed(3) + " m" : "–"})\n` +
      `RSSI ${g.rssi[i]}  ·  noise σ ${(Math.sqrt(g.noiseVar[i]) * 1000).toFixed(0)} mm  ·  layer offset ${this.cfg.layercal.on ? (this.processor.layerBias[l] * 1000).toFixed(1) + " mm" : "off"}\n` +
      `valid ${(valid * 100).toFixed(0)} %  ·  jump rate ${(g.jumpRate[i] * 100).toFixed(0)} %  ·  conf ${g.conf[i].toFixed(2)}` + status;
  }

  // ---------- server state & device status ----------
  private applyState(s: ServerState): void {
    if (!s?.source) return;
    const wasReplay = this.srv?.source === "replay";
    this.srv = s;
    s.replay_error ? this.problems.fail("replay", s.replay_error) : this.problems.ok("replay");
    if (s.source === "replay" && !wasReplay) this.ui.paused = false;   // the player has its own pause
    if (wasReplay && s.source !== "replay") $("subtitle").textContent = "live";
    this.recording.apply(s);
    const dev = deviceSummary(s);
    $("sumDevice").textContent = dev.text; $("sumDeviceDot").className = "dot " + dev.dot;
    this.showPause();
  }

  private async pollState(): Promise<void> {
    try { this.applyState(await this.api.state()); } catch { /* the frame stream reports connectivity */ }
    setTimeout(() => void this.pollState(), 500);
  }

  private async pollStatus(): Promise<void> {
    try {
      const s = await this.api.status();
      const d = s.device || {};
      const replay = this.srv?.source === "replay";
      if (!this.mountChosen && !replay && typeof d.UpsideDown === "boolean" && (d.UpsideDown ? "upsidedown" : "upright") !== this.ui.mount)
        this.setMount(d.UpsideDown ? "upsidedown" : "upright", false);
      if (d.DeviceType && !replay) { $("title").textContent = String(d.DeviceType); $("subtitle").textContent = `SN ${d.SerialNumber} · FW ${d.FirmwareVersion}`; }
      renderDevice(d);
      s.error ? this.problems.fail("sensor", s.error) : this.problems.ok("sensor");
    } catch { /* the frame stream reports connectivity */ }
    setTimeout(() => void this.pollStatus(), 2000);
  }

  // ---------- render loop ----------
  private fpsT = 0;
  private fpsRenders = 0;
  private animate(t: number): void {
    requestAnimationFrame(tt => this.animate(tt));
    if (this.ui.view === "3d") {
      const ft = this.ui.follow ? this.processor.objects?.tracker.byId(this.selected) : undefined;
      if (ft) this.scene.follow(ft.x + ft.box.dx, ft.y + ft.box.dy);
      this.scene.frame();
    }
    if (t - this.fpsT > 1000) {
      this.rendersPerSec = Math.round((this.scene.renders - this.fpsRenders) * 1000 / (t - this.fpsT));
      this.fpsRenders = this.scene.renders; this.fpsT = t;
    }
    const age = performance.now() - this.lastFrameAt, live = this.lastFrameAt && age < 500;
    const paused = this.recording.replaying ? !this.recording.playing : this.ui.paused;
    const dot = "dot " + (paused ? "warn" : live ? "ok" : "err");
    $("streamDot").className = dot; $("sumStreamDot").className = dot;
    $("sumStream").textContent = paused ? "paused" : live ? this.streamText : this.lastFrameAt ? "no data" : "–";
  }
}
