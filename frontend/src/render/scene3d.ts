// 3D view (three.js): surface mesh / points / layer lines from a Geometry, range rings + FOV guides,
// object boxes, trails and HTML labels. Renders on demand: only when something changed or the camera
// moves, i.e. about once per scan with a still camera.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { css, scale } from "../core/colors";
import type { ThemeColors } from "../ui/theme";
import type { Mount, RGB } from "../core/types";
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
export interface OverlayOptions { boxes: boolean; trails: boolean; labels: boolean; selected: number }

const BOX_EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.05, 2000);
  readonly controls: OrbitControls;
  needsRender = true;
  renders = 0;
  private guides = new THREE.Group();
  private pointMat = new THREE.PointsMaterial({ size: 1, sizeAttenuation: false, vertexColors: true });
  private lineMat = new THREE.LineBasicMaterial({ vertexColors: true });
  private meshMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private points?: THREE.Points; private lines?: THREE.LineSegments; private vlines?: THREE.LineSegments; private mesh?: THREE.Mesh;
  private attrs?: { pos: THREE.BufferAttribute; col: THREE.BufferAttribute; nrm: THREE.BufferAttribute };
  private boxes: THREE.LineSegments; private trails: THREE.LineSegments;
  private labelEls = new Map<number, HTMLDivElement>();
  private labelTracks = new Map<number, Track>();
  private draw: DrawMode = "surface+points";
  private v = new THREE.Vector3();
  private colors: Pick<ThemeColors, "bg" | "border" | "grid2" | "accent" | "warn" | "mark"> =
    { bg: "#0e1116", border: "#2a313c", grid2: "#3d4654", accent: "#4aa3ff", warn: "#d29922", mark: "#ffd33d" };
  private sensorMat = new THREE.MeshBasicMaterial({ color: 0xffd33d });
  private sensor = buildSensorModel(this.sensorMat);

  constructor(container: HTMLElement, private labelLayer: HTMLElement, private onSelect: (id: number) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x0e1116);
    container.appendChild(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);                       // sensor frame: x forward, y left, z up
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xdde6f0, 0x2a2f38, 0.9));
    const headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.camera.add(headlight); headlight.position.set(0.3, 0.5, 1);
    this.scene.add(this.camera, this.guides);
    this.scene.add(this.sensor);
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

  /** bind the GPU buffers to a Geometry (once per grid size) */
  bind(geo: Geometry): void {
    for (const o of [this.points, this.lines, this.vlines, this.mesh]) if (o) { this.scene.remove(o); o.geometry.dispose(); }
    const attr = (a: Float32Array) => new THREE.BufferAttribute(a, 3).setUsage(THREE.DynamicDrawUsage);
    this.attrs = { pos: attr(geo.pos), col: attr(geo.col), nrm: attr(geo.nrm) };
    const mk = (idx: Uint32Array, normals: boolean) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", this.attrs!.pos); g.setAttribute("color", this.attrs!.col);
      if (normals) g.setAttribute("normal", this.attrs!.nrm);
      g.setIndex(new THREE.BufferAttribute(idx, 1).setUsage(THREE.DynamicDrawUsage));
      g.setDrawRange(0, 0);
      return g;
    };
    this.points = new THREE.Points(mk(geo.pIdx, false), this.pointMat);
    this.lines = new THREE.LineSegments(mk(geo.lIdx, false), this.lineMat);
    this.vlines = new THREE.LineSegments(mk(geo.vIdx, false), this.lineMat);
    this.mesh = new THREE.Mesh(mk(geo.tIdx, true), this.meshMat);
    for (const o of [this.mesh, this.lines, this.vlines, this.points]) { o.frustumCulled = false; this.scene.add(o); }
    this.setDraw(this.draw);
  }

  /** upload a rebuilt Geometry (same arrays as bound) */
  update(geo: Geometry): void {
    if (!this.attrs || !this.points || !this.lines || !this.vlines || !this.mesh) return;
    this.points.geometry.setDrawRange(0, geo.np);
    this.lines.geometry.setDrawRange(0, geo.nl * 2);
    this.vlines.geometry.setDrawRange(0, geo.nv * 2);
    this.mesh.geometry.setDrawRange(0, geo.nt * 3);
    for (const o of [this.points, this.lines, this.vlines, this.mesh]) o.geometry.index!.needsUpdate = true;
    this.attrs.pos.needsUpdate = this.attrs.col.needsUpdate = this.attrs.nrm.needsUpdate = true;
    this.needsRender = true;
  }

  setDraw(draw: DrawMode): void {
    this.draw = draw;
    const p = drawParts(draw);
    if (this.mesh) this.mesh.visible = p.surface;
    if (this.points) this.points.visible = p.points;
    if (this.lines) this.lines.visible = p.layerLines;
    if (this.vlines) this.vlines.visible = p.vLines;
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

  /** range rings every 5/10 m, ±60° FOV lines, vertical field-of-view fan (lowest / highest layer) */
  buildGuides(maxR: number, fanElevDeg: [number, number], mount: Mount): void {
    this.guides.clear();
    const c = this.colors, ringMat = new THREE.LineBasicMaterial({ color: c.border }), ring10 = new THREE.LineBasicMaterial({ color: c.grid2 });
    const step = maxR > 60 ? 10 : 5;
    for (let r = step; r <= maxR; r += step) {
      const pts: THREE.Vector3[] = [];
      for (let a = -180; a <= 180; a += 2) pts.push(new THREE.Vector3(r * Math.cos(a * Math.PI / 180), r * Math.sin(a * Math.PI / 180), 0));
      this.guides.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), r % (step * 2) === 0 ? ring10 : ringMat));
    }
    const fov = new THREE.LineBasicMaterial({ color: c.accent, transparent: true, opacity: 0.35 });
    for (const a of [-60, 60]) {
      const rad = a * Math.PI / 180;
      this.guides.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
        [new THREE.Vector3(0, 0, 0), new THREE.Vector3(maxR * Math.cos(rad), maxR * Math.sin(rad), 0)]), fov));
    }
    const sgn = mountZSign(mount), fanMat = new THREE.LineBasicMaterial({ color: c.warn, transparent: true, opacity: 0.6 });
    for (const e of fanElevDeg) {
      const el = e * Math.PI / 180;
      this.guides.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
        [new THREE.Vector3(0, 0, 0), new THREE.Vector3(maxR * Math.cos(el), 0, sgn * maxR * Math.sin(el))]), fanMat));
    }
    // mirrored like the rays, but the device's elevations count the other way from the housing (the drawing's
    // fan rises −1.5…13.5° above the window, "upright" data spans −13.19…1.19°): upright data = window at the bottom
    this.sensor.scale.z = -sgn * Math.abs(this.sensor.scale.z);
    this.guides.add(new THREE.AxesHelper(1));         // red x (forward), green y (left), blue z (up)
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
