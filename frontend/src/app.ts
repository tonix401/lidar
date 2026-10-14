// Wires the pieces together: frame stream → Processor → Geometry → 3D/2D views, plus the panel.
import { Api, type Frame } from "./api/client";
import { FrameStream } from "./api/stream";
import { autoConfig, estimateNoise } from "./config/auto";
import { DEFAULT_ADAPTIVE, DEFAULT_INTENSITY, DEFAULT_LAYERCAL, DEFAULT_OBJECTS, defaultConfig, matchingPreset, mergeConfig,
         USER_STAGES, withPreset, type Config, type PresetName, type StageKey } from "./config/config";
import { KEYS, Store } from "./config/storage";
import { turboGradientCss } from "./core/colors";
import { popcount } from "./core/math";
import type { Mount, ServerState } from "./core/types";
import { historyMask } from "./pipeline/history";
import { Processor } from "./pipeline/processor";
import { trackLabel } from "./objects/tracker";
import { buildGeometry, createGeometry, type ColorBy, type Geometry } from "./render/geometry";
import { Scene3D, type CameraView, type DrawMode } from "./render/scene3d";
import { View2D, type View2DData } from "./render/view2d";
import { drawHistogram, drawLayerBias } from "./ui/charts";
import { renderDevice } from "./ui/devicePanel";
import { $ } from "./ui/dom";
import { ObjectsPanel } from "./ui/objectsPanel";
import { Problems } from "./ui/problems";
import { RecordingPanel } from "./ui/recordingPanel";
import { StageControls } from "./ui/stageControls";

type ViewMode = "3d" | "top" | "image";
type Mode = "auto" | "manual";
const OBJECT_TOGGLES = { oHighlight: "highlight", oDim: "dimBg", oBoxes: "boxes", oLabels: "labels", oTrails: "trails", oFollow: "follow" } as const;

export class App {
  readonly api = new Api();
  readonly store = new Store();
  readonly problems = new Problems(lines => { $("err").textContent = lines.join("\n"); });
  ui = { colorBy: "dist" as ColorBy, layer: -1, maxRange: 60, mount: "upright" as Mount, paused: false, draw: "surface+points" as DrawMode,
         pointSize: 1, view: "3d" as ViewMode, highlight: true, dimBg: true, boxes: true, labels: true, trails: true, follow: false };
  mode: Mode = "auto";
  manualCfg: Config = defaultConfig();
  cfg: Config;
  processor: Processor;
  geo: Geometry | null = null;
  selected = 0;
  private mountChosen = false;
  private autoText = "";
  private autoNoise = 0.02;
  private scansSeen = 0;
  private lastEpoch: number | null = null;
  private viewDist = 0;
  private lastFrameAt = 0;
  private listDirty = false;
  private srv: ServerState | null = null;
  private scene: Scene3D;
  private view2d: View2D;
  private stages: StageControls;
  private objectsPanel: ObjectsPanel;
  private recording: RecordingPanel;
  private stream: FrameStream;

  constructor() {
    this.loadSettings();
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
      panelWidth: () => (innerWidth > 600 ? 304 : 0),
      bottomInset: () => ($("transport").hidden ? 0 : 76),
      viewDist: () => this.viewDist,
    });
    this.stages = new StageControls({ default: $("stages"), objects: $("objStage") }, {
      change: (k, p, v) => this.changeParam(k, p, v),
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
    else for (const k of USER_STAGES) (this.manualCfg as unknown as Record<string, unknown>)[k] = structuredClone(this.cfg[k]);
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
    preset.value = matchingPreset(this.cfg); preset.disabled = auto;
    $("resetCfg").hidden = auto;
    $("autoInfo").textContent = auto ? "Auto: " + (this.autoText || "learning the scene…") +
      ". Settings below are chosen from the measured noise and motion and update every second; switch to manual to edit " +
      "(intensity filter and object detection stay editable)." : "";
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
      this.setCfg({ ...this.cfg, intensity: { ...DEFAULT_INTENSITY }, layercal: { ...DEFAULT_LAYERCAL }, adaptive: { ...DEFAULT_ADAPTIVE }, objects: { ...DEFAULT_OBJECTS } });
      this.applyPreset("medium");
    };
    const sel = (id: string, apply: (v: string) => void, value: string) => {
      const s = $<HTMLSelectElement>(id); s.value = value;
      s.onchange = () => { apply(s.value); this.rebuild(); };
    };
    sel("draw", v => { this.ui.draw = v as DrawMode; this.scene.setDraw(this.ui.draw); }, this.ui.draw);
    sel("colorBy", v => { this.ui.colorBy = v as ColorBy; $("legendBox").classList.toggle("hidden", v === "uniform"); }, this.ui.colorBy);
    sel("layerSel", v => { this.ui.layer = +v; }, "-1");
    sel("mount", v => { this.setMount(v as Mount, true); }, this.ui.mount);
    $("legendBox").classList.toggle("hidden", this.ui.colorBy === "uniform");
    $("legend").style.background = turboGradientCss();
    const size = $<HTMLInputElement>("size");
    size.oninput = () => { this.ui.pointSize = +size.value; this.scene.setPointSize(this.ui.pointSize); this.view2d.render(); };
    const range = $<HTMLInputElement>("range");
    range.value = String(this.ui.maxRange); $("rangeVal").textContent = this.ui.maxRange + " m";
    range.oninput = () => {
      this.ui.maxRange = +range.value; $("rangeVal").textContent = this.ui.maxRange + " m";
      this.buildGuides(); this.rebuild();
    };
    for (const [id, key] of Object.entries(OBJECT_TOGGLES)) {
      const cb = $<HTMLInputElement>(id);
      cb.checked = this.ui[key];
      cb.onchange = () => { this.ui[key] = cb.checked; this.store.set(KEYS.objectToggle(key), cb.checked ? "1" : "0"); this.rebuild(); };
    }
    for (const b of Array.from($("modeBtns").children) as HTMLElement[]) b.onclick = () => this.setView(b.dataset.mode as ViewMode);
    const cams: [string, CameraView][] = [["vPersp", "persp"], ["vTop", "top"], ["vSide", "side"], ["vFront", "front"]];
    for (const [id, v] of cams) $(id).onclick = () => this.scene.setView(v, this.viewDist || this.ui.maxRange);
    $("fit2d").onclick = () => { this.view2d.fit(); this.view2d.render(); };
    $("pause").onclick = () => this.togglePause();
    window.addEventListener("keydown", e => {
      if (e.target !== document.body) return;
      if (e.code === "Space") { e.preventDefault(); this.togglePause(); }
      else if (this.recording.replaying && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
        e.preventDefault();
        this.recording.control("step", e.code === "ArrowLeft" ? -1 : 1).then(s => this.applyState(s)).catch(err => this.problems.flash("action", err));
      }
    });
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
    $("cam3d").hidden = v !== "3d"; $("fit2d").hidden = v === "3d";
    $("hint").textContent = v === "3d" ? "drag: rotate · right-drag: pan · wheel: zoom · space: pause"
      : v === "top" ? "drag: pan · wheel: zoom · double-click: fit · hover: inspect · click: select object · space: pause"
      : "drag: pan · wheel: zoom · double-click: fit · grey = no return, pink = removed by filters · space: pause";
    if (v === "3d") this.scene.resize(); else this.view2d.setMode(v);
    this.store.set(KEYS.view, v);
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
    // the server bumps `epoch` whenever the sequence jumps (seek, step back, loop, source switch):
    // per-beam histories and tracks from before the jump would be wrong, so start afresh
    if (meta.epoch !== undefined && meta.epoch !== this.lastEpoch) {
      if (this.lastEpoch !== null) this.processor.reset();
      this.lastEpoch = meta.epoch;
    }
    if (meta.source === "replay" && meta.replay) {
      $("subtitle").textContent = `replaying ${meta.replay.file}`;
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
      this.autoText = `noise floor ${Math.round(est.noise * 1000)} mm (median of ${est.samples} steady beams) · gate 3σ · ` +
        `${(100 * est.movingShare).toFixed(1)} % moving`;
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
    const tintOpts = { selected: this.selected, dimBackground: this.ui.dimBg };
    buildGeometry(g, g.out, this.geo, {
      colorBy: this.ui.colorBy, layer: this.ui.layer, maxRange: this.ui.maxRange, jump: this.cfg.mesh.jump, jumpRel: this.cfg.mesh.jumpRel,
      tint: highlight && objects ? (i, rgb) => objects.tint(i, rgb, tintOpts) : undefined,
    });
    this.scene.update(this.geo);
    if (this.selected && !objects?.tracker.byId(this.selected)) this.selected = 0;
    const tracks = this.visibleTracks();
    this.scene.setOverlays(tracks, { boxes: this.ui.boxes, trails: this.ui.trails, labels: this.ui.labels, selected: this.selected });
    if (this.ui.view !== "3d") this.view2d.render();
    this.objectsPanel.render(tracks, this.selected, !this.cfg.objects.on ? "object detection is off" : objects?.stats || "learning the empty scene…", this.listDirty);
    this.listDirty = false;
    this.panelStats();
  }

  private visibleTracks() { return this.cfg.objects.on ? this.processor.objects?.confirmed ?? [] : []; }

  private panelStats(): void {
    const st = this.processor.stats, geo = this.geo!;
    const parts = ([["intensity", this.cfg.intensity.on, st.intensity], ["outliers", this.cfg.outlier.on, st.outliers], ["flicker", this.cfg.history.on, st.flicker]] as const)
      .filter(([, on]) => on).map(([k, , n]) => `${n} ${k}`);
    $("removed").textContent = parts.length ? parts.join(" · ") : "–";
    $("tris").textContent = geo.nt.toLocaleString();
    $("proc").textContent = (st.ingestMs + st.refineMs).toFixed(0) + " ms";
    const isArea = this.ui.colorBy === "area";
    $("legend").style.visibility = isArea ? "hidden" : "";
    if (isArea) {
      const [f, d, m] = geo.areaCounts;
      $("legMin").textContent = `flat ${f} · detail ${d}`; $("legMax").textContent = `moving ${m}`;
    } else {
      const unit = { rssi: "", dist: " m", height: " m", layer: "", uniform: "", noise: " mm", conf: "", area: "" }[this.ui.colorBy];
      const fmt = (v: number) => this.ui.colorBy === "dist" || this.ui.colorBy === "height" ? v.toFixed(1) : this.ui.colorBy === "conf" ? v.toFixed(2) : String(Math.round(v));
      $("legMin").textContent = fmt(geo.lo) + unit; $("legMax").textContent = fmt(geo.hi) + unit;
    }
    this.drawCharts();
  }

  private view2dData(): View2DData | null {
    const g = this.processor.grid, meta = this.processor.meta, objects = this.processor.objects;
    if (!g || !meta || !this.geo) return null;
    const highlight = this.cfg.objects.on && this.ui.highlight && objects;
    const opts = { selected: this.selected, dimBackground: this.ui.dimBg };
    return {
      grid: g, geo: this.geo, meta, tracks: this.visibleTracks(), draw: this.ui.draw, pointSize: this.ui.pointSize, maxRange: this.ui.maxRange,
      overlay: { boxes: this.ui.boxes, labels: this.ui.labels, trails: this.ui.trails, selected: this.selected },
      byDistance: this.ui.colorBy === "uniform",
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
      `azimuth ${(meta.start_azimuth_deg + b * meta.step_deg).toFixed(2)}°  elevation ${g.elev[i].toFixed(2)}°\n` +
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
      $("fps").textContent = String(Math.round((this.scene.renders - this.fpsRenders) * 1000 / (t - this.fpsT)));
      this.fpsRenders = this.scene.renders; this.fpsT = t;
    }
    const age = performance.now() - this.lastFrameAt;
    $("streamDot").className = "dot " + (this.ui.paused ? "warn" : this.lastFrameAt && age < 500 ? "ok" : "err");
  }
}
