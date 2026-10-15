// The composition root: builds the parts and wires them together. Frame stream → Processor → Geometry →
// 3D / 2D views; the panel's controllers report changes through callbacks, and rebuild() is the one place
// that pushes the pipeline's output into every view.
import { Api, type Frame } from "./api/client";
import { poll } from "./api/poller";
import { FrameStream } from "./api/stream";
import { matchingPreset, type Config, type ViewMode } from "./config/config";
import { ConfigState } from "./config/state";
import { KEYS, Store } from "./config/storage";
import type { Mount, RGB, ServerState } from "./core/types";
import { Processor } from "./pipeline/processor";
import { describeBeam, type BeamContext } from "./render/describe";
import { buildGeometry, createGeometry, typicalRange, type Geometry } from "./render/geometry";
import { Scene3D } from "./render/scene3d";
import { View2D, type View2DData } from "./render/view2d";
import { drawHistogram, drawLayerBias } from "./ui/charts";
import { DisplayControls } from "./ui/displayControls";
import { $ } from "./ui/dom";
import { bindInfoIcons } from "./ui/info";
import { ModeControls } from "./ui/modeControls";
import { ObjectsPanel } from "./ui/objectsPanel";
import { PanelChrome } from "./ui/panelChrome";
import { Problems } from "./ui/problems";
import { RecordingPanel } from "./ui/recordingPanel";
import { loadUi, saveUi, type UiSettings } from "./ui/settings";
import { StageControls } from "./ui/stageControls";
import { STAT_GROUPS, statRows } from "./ui/statRows";
import { StatsPanel } from "./ui/statsPanel";
import { StatusBar } from "./ui/statusBar";
import { applyTheme, hexRGB, themeColors, type Theme } from "./ui/theme";
import { applyViews } from "./ui/views";
import { bindKeys, ViewTabs } from "./ui/viewTabs";

const AUTO_TUNE_EVERY = 10;                    // scans between auto-mode updates

export class App {
  readonly api = new Api();
  readonly store = new Store();
  readonly problems = new Problems(lines => { $("err").textContent = lines.join("\n"); });
  readonly settings: ConfigState;
  readonly ui: UiSettings;
  readonly processor: Processor;
  geo: Geometry | null = null;
  selected = 0;
  private mountChosen: boolean;
  private scansSeen = 0;
  private lastEpoch: number | null = null;
  private viewDist = 0;
  private rendersPerSec = NaN;
  private dimTo: RGB | undefined;
  private listDirty = false;
  private srv: ServerState | null = null;
  private scene: Scene3D;
  private view2d: View2D;
  private stages: StageControls;
  private modes: ModeControls;
  private display: DisplayControls;
  private tabs: ViewTabs;
  private chrome: PanelChrome;
  private objectsPanel: ObjectsPanel;
  private recording: RecordingPanel;
  private status = new StatusBar();
  private statsPanel = new StatsPanel($("statsList"), [...STAT_GROUPS]);
  private stream: FrameStream;

  /** the processing settings in effect */
  get cfg(): Config { return this.settings.cfg; }

  constructor() {
    ({ ui: this.ui, mountChosen: this.mountChosen } = loadUi(this.store));
    this.settings = new ConfigState(this.store.json(KEYS.smoothing));
    bindInfoIcons();
    this.processor = new Processor(this.cfg, this.ui.mount);
    const bias = this.store.json<number[]>(KEYS.layerBias);
    if (Array.isArray(bias)) this.processor.setLayerBias(bias);
    this.processor.onLayerBias = b => { this.store.setJson(KEYS.layerBias, Array.from(b)); this.drawCharts(); };

    this.scene = new Scene3D($("view"), $("labels"), id => this.select(id));
    this.view2d = new View2D($<HTMLCanvasElement>("view2d"), $("tip"), {
      data: () => this.view2dData(),
      describe: i => describeBeam(this.beamContext()!, i),
      objectAt: i => { const t = this.processor.objects?.tracker.byId(this.processor.objects.cell[i]); return t?.confirmed ? t.id : 0; },
      select: id => this.select(id),
      panelWidth: () => (innerWidth > 600 && !$("panel").classList.contains("min") ? $("panel").offsetWidth + 24 : 0),
      bottomInset: () => ($("transport").hidden ? 0 : 76),
      viewDist: () => this.viewDist,
    });
    this.stages = new StageControls({ default: $("stages"), objects: $("objStage"), display: $("meshStage") }, {
      change: (k, p, v) => { this.settings.changeParam(k, p, v); this.configChanged(); },
      resetStage: k => { this.settings.resetStage(k); this.configChanged(); },
      resetCalibration: () => { this.processor.layerBias.fill(0); this.store.setJson(KEYS.layerBias, Array.from(this.processor.layerBias)); this.processor.reset(); this.drawCharts(); },
      extraOpened: () => this.drawCharts(),
    });
    this.modes = new ModeControls({
      mode: m => { this.settings.setMode(m); this.configChanged(); },
      preset: name => { this.settings.applyPreset(name); this.processor.reset(); this.configChanged(); },
      resetAll: () => { this.settings.resetAll(); this.processor.reset(); this.configChanged(); },
    });
    this.objectsPanel = new ObjectsPanel($("objInfo"), $("objList"), id => this.select(id));
    this.recording = new RecordingPanel(this.api, {
      state: s => this.applyState(s), error: e => this.problems.flash("action", e), confirm: msg => window.confirm(msg),
    });
    this.stream = new FrameStream(this.api, f => this.onFrame(f), this.problems.for("server"));
    this.display = new DisplayControls(this.ui, this.store, {
      draw: () => { this.scene.setDraw(this.ui.draw); applyViews($("panel"), this.ui.view, this.ui.draw); },
      mount: m => this.setMount(m, true),
      pointSize: () => { this.scene.setPointSize(this.ui.pointSize); this.view2d.render(); },
      maxRange: () => this.buildGuides(),
      rebuild: refine => this.rebuild(refine),
    });
    this.chrome = new PanelChrome(this.store, {
      opened: () => this.panelStats(),
      layout: refit => { if (this.ui.view !== "3d") { if (refit) this.view2d.fit(); this.view2d.render(); } },
      theme: t => this.setTheme(t),
    });
    this.tabs = new ViewTabs({
      view: v => this.setView(v),
      camera: c => this.scene.setView(c, this.viewDist || this.ui.maxRange),
      fit2d: () => { this.view2d.fit(); this.view2d.render(); },
      pause: () => this.togglePause(),
    });
    bindKeys({
      pause: () => this.togglePause(),
      view: v => this.setView(v),
      togglePanel: () => this.chrome.toggle(),
      step: dir => {
        if (!this.recording.replaying) return false;
        this.recording.control("step", dir).then(s => this.applyState(s)).catch(err => this.problems.flash("action", err));
        return true;
      },
    });
    this.syncControls();
    this.buildGuides();
    this.scene.setDraw(this.ui.draw);
    this.scene.setView("persp", this.ui.maxRange);
    this.setView(this.ui.view);
  }

  start(): void {
    void this.stream.run();
    poll(() => this.pollStatus(), 2000);
    poll(async () => this.applyState(await this.api.state()), 500);
    requestAnimationFrame(t => this.animate(t));
  }

  // ---------- settings ----------
  /** after a settings change by the user: in effect, remembered, shown, and the spatial stages re-run */
  private configChanged(): void {
    this.processor.cfg = this.cfg;
    if (!this.cfg.objects.on) this.processor.objects?.reset();
    this.store.setJson(KEYS.smoothing, this.settings);
    this.syncControls();
    this.rebuild();
  }

  private syncControls(): void {
    this.stages.sync(this.cfg, this.settings.auto);
    this.modes.sync(this.settings.mode, matchingPreset(this.cfg), !this.settings.estimate);
    this.display.sync(this.cfg.walls.on);
    this.drawCharts();
  }

  private drawCharts(): void {
    if (this.stages.histogram && this.stages.isOpen("histogram")) drawHistogram(this.stages.histogram, this.processor.rssiHist, this.cfg.intensity);
    if (this.stages.layerBias && this.stages.isOpen("layerbias")) drawLayerBias(this.stages.layerBias, this.processor.layerBias);
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

  /** `chosen`: picked by the user (remembered); otherwise it follows the device or the recording */
  private setMount(m: Mount, chosen: boolean): void {
    this.ui.mount = m;
    if (chosen) { this.mountChosen = true; saveUi(this.store, this.ui, "mount"); }
    this.display.setMount(m);
    this.processor.setMount(m);
    this.buildGuides();
    this.rebuild();
  }

  private followMount(upsideDown: boolean): void {
    const m = upsideDown ? "upsidedown" : "upright";
    if (!this.mountChosen && m !== this.ui.mount) this.setMount(m, false);
  }

  private buildGuides(): void {
    const g = this.processor.grid;
    const fan: [number, number] = g ? [g.elev[g.B >> 1], g.elev[(g.L - 1) * g.B + (g.B >> 1)]] : [-13.19, 1.19];
    this.scene.buildGuides(Math.min(this.ui.maxRange, 200), fan, this.ui.mount);
  }

  private setView(v: ViewMode): void {
    this.ui.view = v;
    this.tabs.show(v, this.ui.draw, this.recording.replaying);
    saveUi(this.store, this.ui, "view");
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

  private paused(): boolean { return this.recording.replaying ? !this.recording.playing : this.ui.paused; }

  private showPause(): void { this.tabs.showPause(this.paused(), this.recording.replaying); }

  private select(id: number): void {
    this.selected = id === 0 || id === this.selected ? 0 : id;
    this.listDirty = true;                                    // show the selection at once (list is throttled)
    this.rebuild();
  }

  // ---------- frames ----------
  private onFrame({ meta, data }: Frame): void {
    this.status.frame(meta);
    // the server bumps `epoch` whenever the sequence jumps (seek, step back, loop, source switch):
    // per-beam histories and tracks from before the jump would be wrong, so start afresh
    if (meta.epoch !== undefined && meta.epoch !== this.lastEpoch) {
      if (this.lastEpoch !== null) this.processor.reset();
      this.lastEpoch = meta.epoch;
    }
    if (meta.source === "replay" && meta.replay) {
      this.status.replaying(meta.replay.file);
      this.recording.transport(meta.replay);
      if (typeof meta.replay.upside_down === "boolean") this.followMount(meta.replay.upside_down);
    }
    if (this.ui.paused && meta.source !== "replay") return;
    try {
      const first = !this.processor.grid;
      const g = this.processor.ingest(data, meta);
      if (!this.geo || this.geo.N !== g.N) {
        this.geo = createGeometry(g.N);
        this.scene.bind(this.geo);
        this.display.setLayers(g.L);
      }
      if (this.settings.auto && ++this.scansSeen % AUTO_TUNE_EVERY === 0) {
        this.settings.autoTune(g);
        this.processor.cfg = this.cfg;
        this.syncControls();
      }
      if (first || !this.viewDist) {                            // first scan: frame the scene
        this.buildGuides();
        const d = typicalRange(g);
        if (d) {
          this.viewDist = d;
          this.scene.setView("persp", d);
          if (this.ui.view !== "3d") this.view2d.fit();
        }
      }
      this.rebuild(false);
      this.problems.ok("processing");
    } catch (e) {
      this.problems.fail("processing", e);                    // a bad frame must not stop the stream
    }
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
    if ($<HTMLDetailsElement>("statsBox").open) this.statsPanel.render(statRows({
      stats: st, cfg: this.cfg, estimate: this.settings.auto ? this.settings.estimate : null, objects: this.processor.objects,
      tracks: this.visibleTracks(), view: this.ui.view, draw: this.ui.draw, rendersPerSec: this.rendersPerSec, triangles: geo.nt,
    }));
    this.display.legend(geo, this.cfg.cells.on);
    this.drawCharts();
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

  private beamContext(): BeamContext | null {
    const p = this.processor;
    return p.grid && p.meta ? { grid: p.grid, meta: p.meta, geo: this.geo, objects: p.objects, cfg: this.cfg, layerBias: p.layerBias, mount: this.ui.mount } : null;
  }

  // ---------- server state & device status ----------
  private applyState(s: ServerState): void {
    if (!s?.source) return;
    const wasReplay = this.srv?.source === "replay";
    this.srv = s;
    s.replay_error ? this.problems.fail("replay", s.replay_error) : this.problems.ok("replay");
    if (s.source === "replay" && !wasReplay) this.ui.paused = false;   // the player has its own pause
    if (wasReplay && s.source !== "replay") this.status.live();
    this.recording.apply(s);
    this.status.server(s);
    this.showPause();
  }

  private async pollStatus(): Promise<void> {
    const s = await this.api.status();
    const d = s.device || {}, replay = this.srv?.source === "replay";
    if (!replay && typeof d.UpsideDown === "boolean") this.followMount(d.UpsideDown);
    this.status.device(d, replay);
    s.error ? this.problems.fail("sensor", s.error) : this.problems.ok("sensor");
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
    this.status.tick(this.paused());
  }
}
