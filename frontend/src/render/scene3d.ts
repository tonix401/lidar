// 3D view (three.js): surface mesh / points / layer lines from a Geometry, range rings + FOV guides,
// object boxes, trails and HTML labels. Renders on demand: only when something changed or the camera
// moves, i.e. about once per scan with a still camera. With several sensors, each has its own layer: a
// group placed at the sensor's pose in the world, holding its geometry, housing and field-of-view guides.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { css, scale } from "../core/colors";
import type { Mount, RGB, ThemeColors } from "../core/types";
import { toMatrix4, type Pose } from "../fusion/pose";
import { boxCorners, MAX_TRACKS, TRAIL_MAX, trackLabel, type Track } from "../objects/tracker";
import { mountZSign } from "../pipeline/rays";
import type { Geometry } from "./geometry";
import { buildSensorModel } from "./sensorModel";

export type DrawMode = "surface" | "surface+points" | "points" | "lines" | "vlines" | "grid" | "points+lines";

/** what a draw mode shows: layer lines run along each layer, vertical lines join a beam across layers */
export function drawParts(d: DrawMode): { surface: boolean; points: boolean; layerLines: boolean; vLines: boolean } {
  return { surface: d.startsWith("surface"), points: d.includes("points"),
           layerLines: d === "lines" || d === "grid" || d === "points+lines", vLines: d === "vlines" || d === "grid" };
}
export type CameraView = "persp" | "top" | "side" | "front";
/** distance guides on the ground: range rings, or a square grid along the axes */
export type GridStyle = "rings" | "square";

/** square grid spacing for a view out to maxR (m), and every how many lines one is drawn stronger */
export function squareStep(maxR: number): { step: number; major: number } {
  return maxR <= 20 ? { step: 1, major: 5 } : maxR <= 60 ? { step: 5, major: 2 } : { step: 10, major: 2 };
}
export interface OverlayOptions { boxes: boolean; trails: boolean; labels: boolean; selected: number }
/** one sensor's guides: its fan (lowest / highest layer elevation) and mount */
export interface SensorGuides { fan: [number, number]; mount: Mount }

const BOX_EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];

/** one sensor's part of the scene, in its own frame: the group's matrix is its pose */
class SensorLayer {
  readonly group = new THREE.Group();
  readonly guides = new THREE.Group();
  readonly housing: THREE.Object3D;
  points?: THREE.Points; lines?: THREE.LineSegments; vlines?: THREE.LineSegments; mesh?: THREE.Mesh;
  attrs?: { pos: THREE.BufferAttribute; col: THREE.BufferAttribute; nrm: THREE.BufferAttribute };
  readonly stale = new Set<THREE.Object3D | THREE.BufferAttribute>();   // not uploaded while hidden
  hadFills = false;
  constructor(mat: THREE.Material) {
    this.housing = buildSensorModel(mat);
    this.group.matrixAutoUpdate = false;
    this.group.add(this.guides, this.housing);
  }
  get parts() { return [this.mesh, this.lines, this.vlines, this.points]; }
  dispose(): void { for (const o of this.parts) o?.geometry.dispose(); }
}

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.05, 2000);
  readonly controls: OrbitControls;
  needsRender = true;
  renders = 0;
  private guides = new THREE.Group();                  // world: range rings
  private layers: SensorLayer[] = [];
  private pointMat = new THREE.PointsMaterial({ size: 1, sizeAttenuation: false, vertexColors: true });
  private lineMat = new THREE.LineBasicMaterial({ vertexColors: true });
  private meshMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private boxes: THREE.LineSegments; private trails: THREE.LineSegments;
  private labelEls = new Map<number, HTMLDivElement>();
  private labelTracks = new Map<number, Track>();
  private draw: DrawMode = "surface+points";
  private v = new THREE.Vector3();
  private colors: Pick<ThemeColors, "bg" | "border" | "grid2" | "accent" | "warn" | "mark"> =
    { bg: "#0e1116", border: "#2a313c", grid2: "#3d4654", accent: "#4aa3ff", warn: "#d29922", mark: "#ffd33d" };
  private sensorMat = new THREE.MeshBasicMaterial({ color: 0xffd33d });

  constructor(container: HTMLElement, private labelLayer: HTMLElement, private onSelect: (id: number) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x0e1116);
    container.appendChild(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);                       // world (single sensor: its frame): x forward, y left, z up
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xdde6f0, 0x2a2f38, 0.9));
    const headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.camera.add(headlight); headlight.position.set(0.3, 0.5, 1);
    this.scene.add(this.camera, this.guides);
    this.setSensorCount(1);
    const ovMat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95 });
    this.boxes = this.overlay(MAX_TRACKS * 24, ovMat);
    this.trails = this.overlay(MAX_TRACKS * TRAIL_MAX * 2, ovMat);
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  private overlay(nVerts: number, mat: THREE.Material): THREE.LineSegments {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(nVerts * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(nVerts * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    const o = new THREE.LineSegments(g, mat);
    o.frustumCulled = false; o.renderOrder = 10;
    this.scene.add(o);
    return o;
  }

  resize(): void {
    this.needsRender = true;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /** one layer per sensor (a single sensor sits at the origin) */
  setSensorCount(n: number): void {
    while (this.layers.length > n) { const l = this.layers.pop()!; this.scene.remove(l.group); l.dispose(); }
    while (this.layers.length < n) { const l = new SensorLayer(this.sensorMat); this.layers.push(l); this.scene.add(l.group); }
    this.needsRender = true;
  }

  /** where sensor k is in the world */
  setPose(k: number, pose: Pose): void {
    const l = this.layers[k];
    if (!l) return;
    l.group.matrix.fromArray(toMatrix4(pose));
    l.group.matrixWorldNeedsUpdate = true;
    this.needsRender = true;
  }

  setVisible(k: number, on: boolean): void {
    const l = this.layers[k];
    if (l && l.group.visible !== on) { l.group.visible = on; this.needsRender = true; }
  }

  /** bind sensor k's GPU buffers to a Geometry (once per grid size) */
  bind(geo: Geometry, k = 0): void {
    const l = this.layers[k];
    if (!l) return;
    for (const o of l.parts) if (o) { l.group.remove(o); o.geometry.dispose(); }
    const attr = (a: Float32Array) => new THREE.BufferAttribute(a, 3).setUsage(THREE.DynamicDrawUsage);
    const attrs = l.attrs = { pos: attr(geo.pos), col: attr(geo.col), nrm: attr(geo.nrm) };
    const mk = (idx: Uint32Array, normals: boolean) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", attrs.pos); g.setAttribute("color", attrs.col);
      if (normals) g.setAttribute("normal", attrs.nrm);
      g.setIndex(new THREE.BufferAttribute(idx, 1).setUsage(THREE.DynamicDrawUsage));
      g.setDrawRange(0, 0);
      return g;
    };
    l.points = new THREE.Points(mk(geo.pIdx, false), this.pointMat);
    l.lines = new THREE.LineSegments(mk(geo.lIdx, false), this.lineMat);
    l.vlines = new THREE.LineSegments(mk(geo.vIdx, false), this.lineMat);
    l.mesh = new THREE.Mesh(mk(geo.tIdx, true), this.meshMat);
    for (const o of [l.mesh, l.lines, l.vlines, l.points]) { o.frustumCulled = false; l.group.add(o); }
    this.setDraw(this.draw);
  }

  /** upload sensor k's rebuilt Geometry (same arrays as bound): only the parts drawn, only what is used of them */
  update(geo: Geometry, k = 0): void {
    const l = this.layers[k];
    if (!l?.attrs || !l.points || !l.lines || !l.vlines || !l.mesh) return;
    l.points.geometry.setDrawRange(0, geo.np);
    l.lines.geometry.setDrawRange(0, geo.nl * 2);
    l.vlines.geometry.setDrawRange(0, geo.nv * 2);
    l.mesh.geometry.setDrawRange(0, geo.nt * 3);
    const p = drawParts(this.draw), N = geo.N;
    const index = (o: THREE.Object3D & { geometry: THREE.BufferGeometry }, n: number, shown: boolean) => {
      if (!shown) { l.stale.add(o); return; }                 // uploaded in full when shown again (setDraw)
      const a = o.geometry.index!;
      if (n > 0) { a.addUpdateRange(0, n); a.needsUpdate = true; }
    };
    index(l.points, geo.np, p.points);
    index(l.lines, geo.nl * 2, p.layerLines);
    index(l.vlines, geo.nv * 2, p.vLines);
    index(l.mesh, geo.nt * 3, p.surface);
    // vertices: the beams (0..N), the remembered wall (N..2N) only while some is drawn
    const verts = (a: THREE.BufferAttribute) => {
      a.addUpdateRange(0, 3 * N);
      if (geo.fills || l.hadFills) a.addUpdateRange(3 * N, 3 * N);
      a.needsUpdate = true;
    };
    verts(l.attrs.pos); verts(l.attrs.col);
    if (p.surface) verts(l.attrs.nrm); else l.stale.add(l.attrs.nrm);
    l.hadFills = geo.fills > 0;
    this.needsRender = true;
  }

  setDraw(draw: DrawMode): void {
    this.draw = draw;
    const p = drawParts(draw);
    for (const l of this.layers) {
      if (l.mesh) l.mesh.visible = p.surface;
      if (l.points) l.points.visible = p.points;
      if (l.lines) l.lines.visible = p.layerLines;
      if (l.vlines) l.vlines.visible = p.vLines;
      for (const o of l.stale) {                              // skipped while hidden: upload in full
        const shown = o instanceof THREE.BufferAttribute ? p.surface : o.visible;
        if (!shown) continue;
        if (o instanceof THREE.BufferAttribute) o.needsUpdate = true;
        else (o as THREE.Mesh).geometry.index!.needsUpdate = true;
        l.stale.delete(o);
      }
    }
    this.needsRender = true;
  }

  setPointSize(px: number): void { this.pointMat.size = px; this.needsRender = true; }

  /** background, sensor origin mark and guide colours from the theme (call buildGuides afterwards) */
  setTheme(c: ThemeColors): void {
    this.colors = c;
    this.renderer.setClearColor(new THREE.Color(c.bg));
    this.sensorMat.color.set(c.mark);
    this.needsRender = true;
  }

  /** around the world origin, range rings every 5/10 m or a square grid; per sensor ±60° FOV lines, its
   *  vertical field-of-view fan (lowest / highest layer) and axes */
  buildGuides(maxR: number, sensors: SensorGuides[], style: GridStyle = "rings"): void {
    this.guides.clear();
    const c = this.colors, ringMat = new THREE.LineBasicMaterial({ color: c.border }), ring10 = new THREE.LineBasicMaterial({ color: c.grid2 });
    if (style === "square") {
      const { step, major } = squareStep(maxR), n = Math.floor(maxR / step), minor: number[] = [], strong: number[] = [];
      for (let k = -n; k <= n; k++) {
        const v = k * step, to = k % major === 0 ? strong : minor;
        to.push(v, -n * step, 0, v, n * step, 0, -n * step, v, 0, n * step, v, 0);   // x = v and y = v
      }
      for (const [pts, mat] of [[minor, ringMat], [strong, ring10]] as const)
        this.guides.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pts, 3)), mat));
    } else {
      const step = maxR > 60 ? 10 : 5;
      for (let r = step; r <= maxR; r += step) {
        const pts: THREE.Vector3[] = [];
        for (let a = -180; a <= 180; a += 2) pts.push(new THREE.Vector3(r * Math.cos(a * Math.PI / 180), r * Math.sin(a * Math.PI / 180), 0));
        this.guides.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), r % (step * 2) === 0 ? ring10 : ringMat));
      }
    }
    const fov = new THREE.LineBasicMaterial({ color: c.accent, transparent: true, opacity: 0.35 });
    const fanMat = new THREE.LineBasicMaterial({ color: c.warn, transparent: true, opacity: 0.6 });
    const reach = sensors.length > 1 ? Math.min(maxR, 8) : maxR;      // several: short guides, they cross
    this.layers.forEach((l, k) => {
      const { fan, mount } = sensors[k] ?? sensors[0];
      l.guides.clear();
      for (const a of [-60, 60]) {
        const rad = a * Math.PI / 180;
        l.guides.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
          [new THREE.Vector3(0, 0, 0), new THREE.Vector3(reach * Math.cos(rad), reach * Math.sin(rad), 0)]), fov));
      }
      const sgn = mountZSign(mount);
      for (const e of fan) {
        const el = e * Math.PI / 180;
        l.guides.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
          [new THREE.Vector3(0, 0, 0), new THREE.Vector3(reach * Math.cos(el), 0, sgn * reach * Math.sin(el))]), fanMat));
      }
      // mirrored like the rays, but the device's elevations count the other way from the housing (the drawing's
      // fan rises −1.5…13.5° above the window, "upright" data spans −13.19…1.19°): upright data = window at the bottom
      l.housing.scale.z = -sgn * Math.abs(l.housing.scale.z);
      l.guides.add(new THREE.AxesHelper(1));       // red x (forward), green y (left), blue z (up)
    });
    this.needsRender = true;
  }

  /** side and front views keep the camera level, so vertical edges stay vertical on screen */
  setView(kind: CameraView, dist: number): void {
    const d = Math.max(2, Math.min(dist, 40));
    this.controls.target.set(d * 0.35, 0, 0);
    if (kind === "top") this.camera.position.set(d * 0.35, 0, d * 1.6);
    else if (kind === "side") this.camera.position.set(d * 0.35, -d * 1.4, 0);
    else if (kind === "front") { this.camera.position.set(-2.5, 0, 0); this.controls.target.set(d, 0, 0); }
    else this.camera.position.set(-d * 0.5, -d * 0.6, d * 0.6);
    this.controls.update();
    this.needsRender = true;
  }

  /** glide target and camera along with a point (follow mode) */
  follow(x: number, y: number): void {
    const dx = (x - this.controls.target.x) * 0.2, dy = (y - this.controls.target.y) * 0.2;
    if (Math.abs(dx) + Math.abs(dy) < 1e-4) return;
    this.controls.target.x += dx; this.controls.target.y += dy;
    this.camera.position.x += dx; this.camera.position.y += dy;
    this.needsRender = true;
  }

  setOverlays(tracks: Track[], o: OverlayOptions): void {
    const bp = this.boxes.geometry.attributes.position.array as Float32Array, bc = this.boxes.geometry.attributes.color.array as Float32Array;
    const tp = this.trails.geometry.attributes.position.array as Float32Array, tc = this.trails.geometry.attributes.color.array as Float32Array;
    let nb = 0, nt = 0;
    for (const t of tracks) {
      const dim = o.selected && t.id !== o.selected ? 0.35 : t.misses ? 0.5 : 1, col = scale(t.color, dim);
      if (o.boxes) {
        const cs = boxCorners(t);
        for (const e of BOX_EDGES) { bp.set(cs[e], 3 * nb); bc.set(col, 3 * nb); nb++; }
      }
      if (o.trails && t.trail.length >= 4) {
        const z = (t.box.z0 + t.box.z1) / 2, n = t.trail.length / 2;
        for (let k = 1; k < n && nt < tp.length / 3 - 2; k++) {
          const f = (0.25 + 0.75 * k / n) * dim;                    // fades towards the past
          for (const kk of [k - 1, k]) { tp.set([t.trail[2 * kk], t.trail[2 * kk + 1], z], 3 * nt); tc.set(scale(t.color, f), 3 * nt); nt++; }
        }
      }
    }
    this.boxes.geometry.setDrawRange(0, nb); this.trails.geometry.setDrawRange(0, nt);
    for (const ov of [this.boxes, this.trails]) ov.geometry.attributes.position.needsUpdate = ov.geometry.attributes.color.needsUpdate = true;
    this.setLabels(o.labels ? tracks : [], o.selected);
    this.needsRender = true;
  }

  private setLabels(tracks: Track[], selected: number): void {
    const keep = new Set(tracks.map(t => t.id));
    for (const [id, el] of this.labelEls) if (!keep.has(id)) { el.remove(); this.labelEls.delete(id); }
    this.labelTracks = new Map(tracks.map(t => [t.id, t]));
    for (const t of tracks) {
      let el = this.labelEls.get(t.id);
      if (!el) {
        el = document.createElement("div");
        el.className = "olabel";
        const id = t.id;
        el.onclick = () => this.onSelect(id);
        this.labelLayer.append(el); this.labelEls.set(t.id, el);
      }
      el.textContent = trackLabel(t);
      el.style.borderColor = css(t.color as RGB);
      el.classList.toggle("sel", t.id === selected);
      el.classList.toggle("dim", !!selected && t.id !== selected);
    }
  }

  private placeLabels(): void {
    for (const [id, el] of this.labelEls) {
      const t = this.labelTracks.get(id);
      if (!t) continue;
      this.v.set(t.x + t.box.dx, t.y + t.box.dy, t.box.z1 + 0.2).project(this.camera);
      if (this.v.z > 1) { el.style.display = "none"; continue; }
      el.style.display = "";
      el.style.transform = `translate(${((this.v.x + 1) / 2 * innerWidth).toFixed(1)}px, ${((1 - this.v.y) / 2 * innerHeight).toFixed(1)}px) translate(-50%, -100%)`;
    }
  }

  /** call every animation frame; renders only when needed. Returns true if it rendered. */
  frame(): boolean {
    const moved = this.controls.update();
    if (!moved && !this.needsRender) return false;
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
    this.renders++;
    this.needsRender = false;
    return true;
  }
}
