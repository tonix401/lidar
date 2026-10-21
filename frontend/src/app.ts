// The composition root: builds the parts and wires them together. Per sensor: frame stream → Processor →
// Geometry, drawn at the sensor's pose in the 3D view; with several sensors their objects are fused into
// world tracks (fusion/objects.ts). The panel's controllers report changes through callbacks, and rebuild()
// is the one place that pushes the pipeline's output into every view. The panel's per-sensor parts (range
// image, map, statistics, charts) show the primary sensor.
import { Api, type Frame } from "./api/client";
import { poll } from "./api/poller";
import { matchingPreset, type Config, type ViewMode } from "@mrs6000/processing/config/config";
import { ConfigState } from "@mrs6000/processing/config/state";
import { KEYS, Store } from "./ui/storage";
import type { FrameMeta, Mount, RGB, ServerState } from "@mrs6000/processing/core/types";
import { Calibrator } from "@mrs6000/processing/fusion/calib/calibrator";
import { rigEntry } from "@mrs6000/processing/fusion/calib/rig";
import { ObjectFusion, observe, trackInFrame } from "@mrs6000/processing/fusion/objects";
import { apply, compose, invert } from "@mrs6000/processing/fusion/pose";
import { mergeSurfaces, type SurfaceMerge } from "@mrs6000/processing/fusion/surfaces";
import { FrameSync } from "@mrs6000/processing/fusion/sync";
import type { Track } from "@mrs6000/processing/objects/tracker";
import type { OtherSensor } from "@mrs6000/processing/pipeline/crosscheck";
import type { Grid } from "@mrs6000/processing/pipeline/grid";
import type { ProcessorHost } from "./worker/host";
import { describeBeam, type BeamContext } from "./render/describe";
import { buildGeometry, createGeometry, sensorColor, typicalRange, type Geometry } from "./render/geometry";
import { Scene3D } from "./render/scene3d";
import { View2D, type View2DData } from "./render/view2d";
import { SensorView } from "./sensorView";
import { drawHistogram, drawLayerBias } from "./ui/charts";
import { DisplayControls } from "./ui/displayControls";
import { $ } from "./ui/dom";
import { bindInfoIcons } from "./ui/info";
import { ModeControls } from "./ui/modeControls";
import { ObjectsPanel } from "./ui/objectsPanel";
import { PanelChrome } from "./ui/panelChrome";
import { Problems } from "./ui/problems";
import { RecordingPanel } from "./ui/recordingPanel";
import { SensorsPanel } from "./ui/sensorsPanel";
import { loadUi, saveUi, type UiSettings } from "./ui/settings";
import { StageControls } from "./ui/stageControls";
import { STAT_GROUPS, statRows } from "./ui/statRows";
import { StatsPanel } from "./ui/statsPanel";
import { StatusBar } from "./ui/statusBar";
import { applyTheme, hexRGB, themeColors, type Theme } from "./ui/theme";
import { applyViews } from "./ui/views";
import { bindKeys, ViewTabs } from "./ui/viewTabs";

const AUTO_TUNE_EVERY = 10;                    // scans between auto-mode updates
const SENDING_MS = 500;                        // a sensor silent this long is not waited for
const MERGE_EVERY_MS = 1000;                   // shared surfaces are recomputed this often (static: they change slowly)

export class App {
  readonly api = new Api();
  readonly store = new Store();
  readonly problems = new Problems(lines => { $("err").textContent = lines.join("\n"); });
  readonly settings: ConfigState;
  readonly ui: UiSettings;
  sensors: SensorView[] = [];
  primaryIdx = 0;
  readonly fusion = new ObjectFusion();
  selected = 0;
  private calibrator: Calibrator | null = null;
  private started = false;
  private rigKey = "";                          // source + recording the poses were loaded for
  private mountChosen: boolean;
  private scansSeen = 0;
  private viewDist = 0;
  private rendersPerSec = NaN;
  private dimTo: RGB | undefined;
  private listDirty = false;
  private mainRange: [number, number] | null = null;   // colour scale of "distance to main sensor"
  private readonly sync = new FrameSync();      // several sensors: which new scans to draw together
  private showTime = 0;                         // shared-clock time of the set last drawn
  private mergeAt = 0;                          // performance.now() of the last surface merge (0 = due)
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
  private sensorsPanel: SensorsPanel;
  private status = new StatusBar();
  private statsPanel = new StatsPanel($("statsList"), [...STAT_GROUPS]);

  /** the processing settings in effect */
  get cfg(): Config { return this.settings.cfg; }
  /** the sensor the panel's per-sensor parts show */
  get primary(): SensorView { return this.sensors[this.primaryIdx] ?? this.sensors[0]; }
  get processor(): ProcessorHost { return this.primary.processor; }
  get geo(): Geometry | null { return this.primary.geo; }
  /** several sensors: world frame, fused objects */
  get multi(): boolean { return this.sensors.length > 1; }

  constructor() {
    ({ ui: this.ui, mountChosen: this.mountChosen } = loadUi(this.store));
    this.settings = new ConfigState(this.store.json(KEYS.smoothing));
    bindInfoIcons();

    this.scene = new Scene3D($("view"), $("labels"), id => this.select(id));
    this.view2d = new View2D($<HTMLCanvasElement>("view2d"), $("tip"), {
      data: () => this.view2dData(),
      describe: i => describeBeam(this.beamContext()!, i),
      objectAt: i => this.trackAt(this.primary, i),
      select: id => this.select(id),
      panelWidth: () => (innerWidth > 600 && !$("panel").classList.contains("min") ? $("panel").offsetWidth + 24 : 0),
      bottomInset: () => ($("transport").hidden ? 0 : 76),
      viewDist: () => this.viewDist,
    });
    this.stages = new StageControls({ default: $("stages"), objects: $("objStage"), display: $("meshStage") }, {
      change: (k, p, v) => { this.settings.changeParam(k, p, v); this.configChanged(); },
      resetStage: k => { this.settings.resetStage(k); this.configChanged(); },
      resetCalibration: () => { const v = this.primary; v.processor.setLayerBias(new Float32Array(v.processor.layerBias.length)); v.saveBias(); v.processor.reset(); this.drawCharts(); },
      extraOpened: () => this.drawCharts(),
    });
    this.modes = new ModeControls({
      mode: m => { this.settings.setMode(m); this.configChanged(); },
      preset: name => { this.settings.applyPreset(name); this.resetAll(); this.configChanged(); },
      resetAll: () => { this.settings.resetAll(); this.resetAll(); this.configChanged(); },
    });
    this.objectsPanel = new ObjectsPanel($("objInfo"), $("objList"), id => this.select(id));
    this.recording = new RecordingPanel(this.api, {
      state: s => this.applyState(s), error: e => this.problems.flash("action", e), confirm: msg => window.confirm(msg),
    });
    this.sensorsPanel = new SensorsPanel({
      primary: k => { this.primaryIdx = k; this.mainRange = null; this.display.setLayers(this.primary.processor.grid?.L ?? 24); this.rebuild(false); this.renderSensors(true); },
      visible: (k, on) => { const v = this.sensors[k]; if (v) { v.visible = on; this.scene.setVisible(k, on); } },
      calibrate: () => this.startCalibration(),
      cancel: () => { this.calibrator?.cancel(); this.calibrator = null; this.showCalibration(); },
      accept: () => void this.acceptCalibration(),
      discard: () => { this.calibrator = null; this.showCalibration(); },
    });
    this.display = new DisplayControls(this.ui, this.store, {
      draw: () => { this.scene.setDraw(this.ui.draw); applyViews($("panel"), this.ui.view, this.ui.draw); },
      mount: m => this.setMount(m, true),
      pointSize: () => { this.scene.setPointSize(this.ui.pointSize); this.view2d.render(); },
      maxRange: () => { this.buildGuides(); if (this.ui.view === "top") this.view2d.render(); },
      rebuild: refine => this.rebuild(refine),
    });
    this.setSensors(["sensor"]);              // after Display (it sets it up), before PanelChrome (it calls back from its constructor)
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
    this.scene.setDraw(this.ui.draw);
    this.scene.setView("persp", this.ui.maxRange);
    this.setView(this.ui.view);
  }

  start(): void {
    this.started = true;
    for (const v of this.sensors) v.start();
    poll(() => this.pollStatus(), 2000);
    poll(async () => this.applyState(await this.api.state()), 500);
    requestAnimationFrame(t => this.animate(t));
  }

  // ---------- sensors ----------
  /** the current source's sensors changed (start, live ↔ replay, another recording): one view each */
  private setSensors(names: string[]): void {
    for (const v of this.sensors) v.stop();
    const multi = names.length > 1;
    this.sensors = names.map((name, k) => {
      const v: SensorView = new SensorView(name, k, this.cfg, this.ui.mount, this.store, this.api, (view, f) => this.onFrame(view, f),
                                           this.problems.for("server"), multi, {
        scan: (meta, first) => this.onScan(v, meta, first),
        refined: () => { if (this.sensors.includes(v)) this.rebuild(false, [v]); },
        error: e => this.problems.fail("processing", e),
      });
      v.processor.onLayerBias = () => { v.saveBias(); if (v === this.primary) this.drawCharts(); };
      return v;
    });
    this.primaryIdx = 0;
    this.selected = 0;
    this.fusion.reset();
    this.sync.reset();
    this.calibrator = null;
    this.scene.setSensorCount(0);                               // drop the old sensors' geometry
    this.scene.setSensorCount(names.length);
    this.sensorsPanel.show(multi);
    this.display.setMulti(multi);
    this.mergeAt = 0;
    this.showCalibration();
    this.buildGuides();
    if (this.started) for (const v of this.sensors) v.start();
  }

  /** the rig's poses (rig.json, or the session's) */
  private async loadRig(): Promise<void> {
    try {
      const rig = await this.api.rig();
      for (const v of this.sensors) v.setRig(rig.sensors.find(r => r.name === v.name));
      this.sensors.forEach((v, k) => this.scene.setPose(k, v.pose));
      this.fusion.reset();                                      // tracks fused with the old poses
      this.mergeAt = 0;                                         // shared surfaces too
      this.mainRange = null;
      this.listDirty = true;
      this.rebuild(false);
      this.renderSensors(true);
    } catch (e) {
      this.problems.flash("action", e);
    }
  }

  private renderSensors(force = false): void {
    if (!this.multi) return;
    const now = performance.now();
    this.sensorsPanel.render(this.sensors.map((v, k) => ({
      name: v.name, color: sensorColor(k), pose: v.pose, calibrated: v.calibrated, rate: v.meta?.rate ?? 0,
      live: now - v.frameAt < 1000, primary: k === this.primaryIdx, visible: v.visible,
    })), force);
  }

  // ---------- calibration ----------
  private startCalibration(): void {
    this.calibrator = new Calibrator(this.sensors.map(v => v.name));
    this.calibrator.start();
    this.showCalibration();
  }

  private showCalibration(): void {
    const c = this.calibrator;
    if (!c) { this.sensorsPanel.calibration("idle", "", null); return; }
    const p = c.progress();
    const text = c.phase === "empty" ? "Step 1 of 2: keep the area empty while every sensor learns it…"
      : c.phase === "walk" ? `Step 2 of 2: walk a wide loop through the area every sensor sees (${p.seconds.toFixed(0)} s; ` +
                             `tracked by ${c.names.map((n, k) => `${n} ${p.samples[k]}×`).join(", ")})` + (p.ready ? " — solving…" : "")
      : c.phase === "done" ? "Check the 3D view: walls and floor should meet. Use these poses?" : "";
    this.sensorsPanel.calibration(c.phase, text, c.result, c.error);
  }

  /** solve once the walk is long enough; previews the result in the 3D view */
  private maybeSolve(): void {
    const c = this.calibrator;
    if (!c || c.phase !== "walk" || !c.progress().ready) return;
    this.showCalibration();
    setTimeout(() => {                                          // let "solving…" show: ~1 s of work
      const res = c.solve(this.sensors.map(v => v.processor));
      if (res) res.forEach((r, k) => this.scene.setPose(k, r.pose));
      this.showCalibration();
    }, 50);
  }

  private async acceptCalibration(): Promise<void> {
    const res = this.calibrator?.result;
    if (!res) return;
    try {
      await this.api.putRig(res.map(r => rigEntry(r)));
      this.calibrator = null;
      this.showCalibration();
      await this.loadRig();
    } catch (e) {
      this.problems.flash("action", e);
    }
  }

  // ---------- settings ----------
  /** after a settings change by the user: in effect, remembered, shown, and the spatial stages re-run */
  private configChanged(): void {
    for (const v of this.sensors) {
      v.processor.cfg = this.cfg;
      if (!this.cfg.objects.on) v.processor.objects?.reset();
    }
    if (!this.cfg.objects.on) this.fusion.reset();
    this.store.setJson(KEYS.smoothing, this.settings);
    this.syncControls();
    this.rebuild();
  }

  private resetAll(): void { for (const v of this.sensors) v.processor.reset(); this.fusion.reset(); }

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

  /** `chosen`: picked by the user (remembered, every sensor); otherwise each follows its device or recording */
  private setMount(m: Mount, chosen: boolean, only?: SensorView): void {
    if (chosen) { this.mountChosen = true; saveUi(this.store, this.ui, "mount"); }
    for (const v of only ? [only] : this.sensors) v.processor.setMount(m);
    if (!only || only === this.primary) { this.ui.mount = m; this.display.setMount(m); }
    this.buildGuides();
    this.rebuild();
  }

  private followMount(v: SensorView, upsideDown: boolean): void {
    const m = upsideDown ? "upsidedown" : "upright";
    if (!this.mountChosen && m !== v.processor.mount) this.setMount(m, false, this.multi ? v : undefined);
  }

  private buildGuides(): void {
    this.scene.buildGuides(Math.min(this.ui.maxRange, 200), this.sensors.map(v => {
      const g = v.processor.grid;
      return { fan: g ? [g.elev[g.B >> 1], g.elev[(g.L - 1) * g.B + (g.B >> 1)]] : [-13.19, 1.19], mount: v.processor.mount };
    }), this.ui.gridStyle);
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

  // ---------- objects: one sensor's, or the fused world tracks ----------
  private trackById(id: number): Track | undefined {
    return this.multi ? this.fusion.tracker.byId(id) : this.processor.objects?.tracker.byId(id);
  }

  /** the confirmed track beam i of sensor v belongs to (0 = none) */
  private trackAt(v: SensorView, i: number): number {
    const det = v.processor.objects, id = det?.cell[i] ?? 0;
    if (!id) return 0;
    const t = this.multi ? this.fusion.tracker.byId(this.fusion.ownerOf(v.index, id)) : det!.tracker.byId(id);
    return t?.confirmed ? t.id : 0;
  }

  /** highlighting for sensor v's beams: its objects in their (fused) colour, the rest dimmed */
  private tinter(v: SensorView) {
    const det = v.processor.objects;
    if (!this.cfg.objects.on || !this.ui.highlight || !det) return { tint: undefined, fillTint: undefined };
    const opts = { selected: this.selected, dimBackground: this.ui.dimBg, dimTo: this.dimTo };
    if (!this.multi) return { tint: (i: number, rgb: RGB) => det.tint(i, rgb, opts), fillTint: (rgb: RGB) => det.tintBackground(rgb, opts) };
    const any = this.fusion.confirmed.length > 0, dim = (rgb: RGB) => (opts.dimBackground && any ? det.tintBackground(rgb, opts) : rgb);
    return {
      tint: (i: number, rgb: RGB): RGB => {
        const id = det.cell[i], t = id ? this.fusion.tracker.byId(this.fusion.ownerOf(v.index, id)) : undefined;
        if (!t?.confirmed) return id ? [0.85, 0.85, 0.85] : dim(rgb);
        return opts.selected && t.id !== opts.selected ? t.color.map(c => c * 0.45) as RGB : t.color;
      },
      fillTint: dim,
    };
  }

  // ---------- frames ----------
  private onFrame(v: SensorView, { meta, data }: Frame): void {
    if (!this.sensors.includes(v)) return;                    // a stream of a source that is gone
    const primary = v === this.primary;
    if (primary) this.status.frame(meta);
    // the server bumps `epoch` whenever the sequence jumps (seek, step back, loop, source switch):
    // per-beam histories and tracks from before the jump would be wrong, so start afresh
    if (meta.epoch !== undefined && meta.epoch !== v.lastEpoch) {
      if (v.lastEpoch !== null) { v.processor.reset(); this.fusion.reset(); }
      v.lastEpoch = meta.epoch;
    }
    if (meta.source === "replay" && meta.replay) {
      this.status.replaying(meta.replay.file);
      this.recording.transport(meta.replay);
    }
    const ud = typeof meta.upside_down === "boolean" ? meta.upside_down : meta.replay?.upside_down;
    if (typeof ud === "boolean") this.followMount(v, ud);
    if (this.ui.paused && meta.source !== "replay") return;
    try {
      v.processor.ingest(data, meta, () => this.othersFor(v, (meta.ts || performance.now() / 1000) + v.timeOffset));
    } catch (e) {
      this.problems.fail("processing", e);                    // a bad frame must not stop the stream
    }
  }

  /** sensor v's pipeline has processed a new scan (in its worker): into the views */
  private onScan(v: SensorView, meta: FrameMeta, first: boolean): void {
    if (!this.sensors.includes(v)) return;
    const primary = v === this.primary;
    try {
      const g = v.processor.grid!;
      v.meta = meta; v.frameAt = performance.now(); v.ts = (meta.ts || v.frameAt / 1000) + v.timeOffset;
      if (!v.geo || v.geo.N !== g.N) {
        v.geo = createGeometry(g.N);
        this.scene.bind(v.geo, v.index);
        if (primary) this.display.setLayers(g.L);
      }
      if (primary && this.settings.auto && ++this.scansSeen % AUTO_TUNE_EVERY === 0) {
        this.settings.autoTune(g);
        for (const s of this.sensors) s.processor.cfg = this.cfg;
        this.syncControls();
      }
      if (first) this.buildGuides();
      if (primary && (first || !this.viewDist)) {               // first scan: frame the scene
        const d = typicalRange(g);
        if (d) {
          this.viewDist = d;
          this.scene.setView("persp", d);
          if (this.ui.view !== "3d") this.view2d.fit();
        }
      }
      if (!this.multi) this.rebuild(false, [v]);
      else { this.fuse(v); this.show(this.sync.add(v.index, v.frameAt, this.sending())); }
      this.problems.ok("processing");
    } catch (e) {
      this.problems.fail("processing", e);                    // a bad frame must not stop the stream
    }
  }

  /** the rig's other sensors as sensor v's cross-check needs them (pipeline/crosscheck.ts): v's frame → theirs,
   *  their latest ranges and how old those are. Only between calibrated sensors and never during a calibration:
   *  with wrong poses they would "see through" each other everywhere. */
  private othersFor(v: SensorView, ts: number): OtherSensor[] {
    if (!this.multi || this.calibrator || !v.calibrated) return [];
    const now = performance.now();
    return this.sensors.flatMap(o => {
      const g = o.processor.grid, m = o.meta;
      if (o === v || !g || !m || !o.calibrated || now - o.frameAt > SENDING_MS) return [];
      const T = compose(invert(o.pose), v.pose);
      const layerSin = Float32Array.from({ length: g.L }, (_, l) => g.rayZ[l * g.B + (g.B >> 1)]);
      return [{ R: T.R, t: T.t, L: g.L, B: g.B, az0: m.start_azimuth_deg, step: m.step_deg, layerSin, range: g.out, age: ts - o.ts }];
    });
  }

  /** this sensor's objects into the world, and its scan to the calibration */
  private fuse(v: SensorView): void {
    const det = v.processor.objects, g = v.processor.grid;
    v.obs = det && g && this.cfg.objects.on ? observe(v.index, v.pose, v.ts, det, g) : [];
    this.calibrator?.scan(v.index, v.ts, v.processor, this.sensors.map(s => s.processor));
    if (this.calibrator) { this.maybeSolve(); if (v.index === 0) this.showCalibration(); }
  }

  /** the sensors whose frames are arriving: a set waits for these */
  private sending(): number[] {
    const now = performance.now();
    return this.sensors.flatMap((s, k) => (now - s.frameAt < SENDING_MS ? [k] : []));
  }

  /** draw a set of sensors' new scans together (FrameSync), with the objects fused at the newest one's time */
  private show(ks: number[]): void {
    const set = ks.flatMap(k => this.sensors[k] ?? []);
    if (!set.length) return;
    this.showTime = Math.max(...set.map(s => s.ts));
    if (this.cfg.objects.on) this.fusion.update(this.sensors.flatMap(s => s.obs), this.showTime, this.cfg.objects);
    if (this.ui.mergeSurfaces && performance.now() - this.mergeAt > MERGE_EVERY_MS) this.mergeShared();
    this.rebuild(false, set);
  }

  /** where the sensors' static surfaces overlap: one fused surface, drawn by the sensor that sees it best */
  private mergeShared(): void {
    this.mergeAt = performance.now();
    const ready = this.sensors.filter(v => v.processor.grid);
    const res = mergeSurfaces(ready.map(v => {
      const g = v.processor.grid!, bg = v.processor.objects?.bgModel, range = new Float32Array(g.N);
      for (let i = 0; i < g.N; i++) range[i] = g.wallN[i] > 0 ? g.wall[i] : bg?.ready ? bg.bg[i] : 0;   // the static surface
      return { pose: v.pose, L: g.L, B: g.B, rayX: g.rayX, rayY: g.rayY, rayZ: g.rayZ, range };
    }));
    ready.forEach((v, k) => { v.merge = res[k]; });
  }

  /** re-run spatial stages (unless just done by ingest) and redraw: every sensor, or just `only` (new scans) */
  rebuild(refine = true, only?: SensorView[]): void {
    if (this.ui.colorBy !== "mainDist") this.mainRange = null;
    for (const v of only ?? this.sensors) this.drawSensor(v, refine);
    if (this.ui.colorBy === "mainDist" && this.updateMainRange()) for (const v of this.sensors) this.drawSensor(v, false);
    if (!this.geo) return;
    const objects = this.processor.objects;
    if (this.selected && !this.trackById(this.selected)) this.selected = 0;
    const tracks = this.visibleTracks();
    this.scene.setOverlays(tracks, { boxes: this.ui.boxes, trails: this.ui.trails, labels: this.ui.labels, selected: this.selected });
    if (this.ui.view !== "3d" && (!only || only.includes(this.primary))) this.view2d.render();
    this.objectsPanel.render(tracks, this.selected, !this.cfg.objects.on ? "object detection is off"
      : !objects?.bgModel.ready ? "learning the empty scene…" : tracks.length ? "" : "no objects", this.listDirty);
    $("objCount").textContent = tracks.length ? String(tracks.length) : "";
    this.listDirty = false;
    this.renderSensors();
    this.panelStats();
  }

  /** one sensor's geometry, uploaded to the 3D view */
  private drawSensor(v: SensorView, refine: boolean): void {
    const g = v.processor.grid;
    if (!g || !v.geo) return;
    if (refine) v.processor.refine();
    const image = this.ui.view === "image" && v === this.primary;   // every beam has its cell there
    const { tint, fillTint } = this.tinter(v);
    const m = this.multi && this.ui.mergeSurfaces && this.ui.view === "3d" ? v.merge : null;   // the 2D views show one sensor
    const { D, fill, hide } = m && m.ref.length === g.N ? this.merged(g, m) : { D: g.out, fill: this.ui.fillWalls ? g.fill : null, hide: null };
    buildGeometry(g, D, v.geo, {
      colorBy: this.ui.colorBy, sensor: v.index, layer: image ? -1 : this.ui.layer, maxRange: image ? Infinity : this.ui.maxRange,
      origin: apply(invert(v.pose), this.primary.pose.t), range: this.mainRange ?? undefined,
      jump: this.cfg.mesh.jump, jumpRel: this.cfg.mesh.jumpRel, tint,
      cells: v.processor.cells?.assign,
      fill,
      fillTint,
      front: this.cfg.outline.on ? g.front : null,
      seesWall: this.cfg.outline.on ? g.seesWall : null,
      hide,
    });
    if (this.multi) this.moveObjects(v);
    this.scene.update(v.geo, v.index);
  }

  /** a sensor's scan with its shared static surfaces on the fused surface and the spots another sensor draws
   *  hidden: only beams that still see that surface, never a person in front of it */
  private merged(g: Grid, m: SurfaceMerge): { D: Float32Array; fill: Float32Array | null; hide: Uint8Array } {
    const D = Float32Array.from(g.out), F = this.ui.fillWalls ? Float32Array.from(g.fill) : null, hide = new Uint8Array(g.N);
    const sees = (d: number, r: number) => d > 0 && Math.abs(d - r) <= 0.05 + 0.01 * r;
    for (let i = 0; i < g.N; i++) {
      if (!m.fused[i]) continue;                                // not shared (nor hidden)
      if (sees(D[i], m.ref[i])) { D[i] = m.fused[i]; hide[i] = m.hide[i]; }
      if (F && sees(F[i], m.ref[i])) F[i] = m.hide[i] ? 0 : m.fused[i];
    }
    return { D, fill: F, hide };
  }

  /** the scans of a set are up to ~70 ms apart (the mirrors are not phase-locked): each tracked object's points
   *  move along its velocity to the set's time, so a walking person's parts from different sensors line up */
  private moveObjects(v: SensorView): void {
    const det = v.processor.objects, P = v.geo!.pos, dt = this.showTime - v.ts;
    if (!det || !(dt > 0 && dt < 0.2)) return;
    for (let i = 0; i < det.cell.length; i++) {
      const t = det.cell[i] ? det.tracker.byId(det.cell[i]) : undefined;
      if (!t || t.static) continue;
      P[3 * i] += t.vx * dt; P[3 * i + 1] += t.vy * dt;           // sensor frame, like the track
    }
  }

  /** colour by distance to the main sensor: one scale for every sensor, so a surface several sensors see has one
   *  colour (each scan's own 2nd..98th percentile made them clash). It follows the spread of all sensors' scans
   *  only when that moved by more than 10 %, so the colours don't pulse. Returns true if it changed. */
  private updateMainRange(): boolean {
    const spans = this.sensors.flatMap(v => (v.geo?.np ? [v.geo.span] : []));
    if (!spans.length) return false;
    const lo = Math.min(...spans.map(r => r[0])), hi = Math.max(...spans.map(r => r[1])), cur = this.mainRange;
    if (cur && Math.abs(lo - cur[0]) <= 0.1 * (cur[1] - cur[0]) && Math.abs(hi - cur[1]) <= 0.1 * (cur[1] - cur[0])) return false;
    this.mainRange = [lo, hi];
    return true;
  }

  private visibleTracks(): Track[] {
    if (!this.cfg.objects.on) return [];
    return this.multi ? this.fusion.confirmed : this.processor.objects?.confirmed ?? [];
  }

  private panelStats(): void {
    const geo = this.geo, st = this.processor.stats;
    if (!geo) return;
    $("sumStats").textContent = `${(st.ingestMs + st.refineMs).toFixed(0)} ms per scan` + (this.multi ? ` (${this.primary.name})` : "");
    if ($<HTMLDetailsElement>("statsBox").open) this.statsPanel.render(statRows({
      stats: st, cfg: this.cfg, estimate: this.settings.auto ? this.settings.estimate : null, objects: this.processor.objects,
      tracks: this.visibleTracks(), view: this.ui.view, draw: this.ui.draw, rendersPerSec: this.rendersPerSec, triangles: geo.nt,
      multi: this.multi,
    }));
    this.display.legend(geo, this.cfg.cells.on);
    this.drawCharts();
  }

  /** the map and the range image: the primary sensor in its own frame (with several sensors, the fused tracks
   *  moved into it) */
  private view2dData(): View2DData | null {
    const v = this.primary, g = v.processor.grid, meta = v.processor.meta;
    if (!g || !meta || !v.geo) return null;
    const { tint } = this.tinter(v), tracks = this.visibleTracks().map(t => (this.multi ? trackInFrame(t, v.pose) : t));
    return {
      grid: g, geo: v.geo, meta, tracks, draw: this.ui.draw, pointSize: this.ui.pointSize, maxRange: this.ui.maxRange,
      overlay: { boxes: this.ui.boxes, labels: this.ui.labels, trails: this.ui.trails, selected: this.selected },
      byDistance: this.ui.colorBy === "uniform", gridStyle: this.ui.gridStyle,
      upsideDown: v.processor.mount === "upsidedown",
      tint: tint ?? ((_i, rgb) => rgb),
      follow: this.ui.follow ? tracks.find(t => t.id === this.selected) : undefined,
    };
  }

  private beamContext(): BeamContext | null {
    const p = this.processor;
    return p.grid && p.meta ? { grid: p.grid, meta: p.meta, geo: this.geo, objects: p.objects, cfg: this.cfg, layerBias: p.layerBias, mount: p.mount } : null;
  }

  // ---------- server state & device status ----------
  private applyState(s: ServerState): void {
    if (!s?.source) return;
    const wasReplay = this.srv?.source === "replay";
    this.srv = s;
    const names = s.sensors?.length ? s.sensors : ["sensor"];
    if (names.join("\n") !== this.sensors.map(v => v.name).join("\n")) { this.setSensors(names); this.rigKey = ""; }
    const rigKey = s.source + (s.source === "replay" ? `:${s.replay.file ?? ""}` : "");
    if (this.multi && rigKey !== this.rigKey) { this.rigKey = rigKey; void this.loadRig(); }   // rig.json, or the session's
    s.replay_error ? this.problems.fail("replay", s.replay_error) : this.problems.ok("replay");
    if (s.source === "replay" && !wasReplay) this.ui.paused = false;   // the player has its own pause
    if (wasReplay && s.source !== "replay") this.status.live();
    this.recording.apply(s);
    this.status.server(s);
    this.showPause();
  }

  private async pollStatus(): Promise<void> {
    const v = this.primary, s = await this.api.status(this.multi ? v.name : undefined);
    const d = s.device || {}, replay = this.srv?.source === "replay";
    if (!replay && typeof d.UpsideDown === "boolean") this.followMount(v, d.UpsideDown);
    this.status.device(d, replay);
    s.error ? this.problems.fail("sensor", s.error) : this.problems.ok("sensor");
  }

  // ---------- render loop ----------
  private fpsT = 0;
  private fpsRenders = 0;
  private animate(t: number): void {
    requestAnimationFrame(tt => this.animate(tt));
    if (this.multi) this.show(this.sync.poll(performance.now()));
    if (this.ui.view === "3d") {
      const ft = this.ui.follow ? this.trackById(this.selected) : undefined;
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
