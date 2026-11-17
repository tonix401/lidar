// The source server's page: its sensors (add, change, remove; their live state), recording and the recordings
// (download, delete), calibrating the rig (live or on a recording, with the result seen from above before it is
// used), the processing servers connected to it and the registered ones, and the server's own settings. Everything
// goes through the HTTP API (src/http.ts).
import { css, trackColor } from "@mrs6000/processing/core/colors";
import { fmtMB, fmtTime } from "@mrs6000/processing/core/format";
import { pointInPolygon, type Region } from "@mrs6000/processing/fusion/calib/region";
import { SettingsForm } from "@mrs6000/web/settingsForm";
import "@mrs6000/web/settingsForm.css";
import type { SettingsSaved, SettingsView } from "@mrs6000/wire/settings";
import "./styles.css";

interface SensorStatus { name: string; ip: string; error: string; rate: number; clock: { offset_s: number; drift_ppm: number; samples: number }; device: string | null; upside_down: boolean | null }
interface Pose { x: number; y: number; z: number; yaw: number; pitch: number; roll: number }
interface SensorEntry { name: string; ip?: string; enabled?: boolean; mount?: string; pose?: Pose; calibrated?: string }
interface Recording { name: string; bytes: number; scans?: number; seconds?: number; created?: number; sensors?: string[]; error?: string }
interface RecorderState { active: boolean; error: string; file?: string; scans?: number; bytes?: number; seconds?: number }
interface ReplayInfo {
  id: string; recording: string; mode: "stream" | "pull"; owner: string; sensors: string[]; count: number; consumers: number; error: string;
  replay: { index?: number; count?: number; t?: number; duration?: number; playing?: boolean; speed?: number };
}
interface HubState { sensors: SensorStatus[]; recording: RecorderState; replays: ReplayInfo[]; calibration: string | null }
interface Calibration {
  target?: string; origin?: string; region?: Region | null; cut?: number; phase: string; seconds?: number; samples?: number[]; ready?: boolean; solving?: boolean; error?: string;
  result?: { name: string; pose: Pose; problems: string[]; quality: Record<string, unknown> | null }[] | null;
}
interface Points { sensors: { name: string; pose: Pose; xy: number[] }[] }
interface Consumer { id: string; name: string; registered: boolean; source: string | null; owns: boolean; sent: number; dropped: number; since: number }
interface ConsumerEntry { name: string; token: string }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const color = (k: number) => css(trackColor(k + 1));                  // as the debug page colours sensors

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
}

// ---------- the API ----------
const store = { get: (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } },
                set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = store.get("mrs6000.source.token"), headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((out as { error?: string }).error ?? `HTTP ${r.status}`);
  return out as T;
}

function problem(e: unknown): void {
  const p = $("problem");
  p.textContent = e instanceof Error ? e.message : String(e);
  p.hidden = false;
  clearTimeout((problem as { t?: number }).t);
  (problem as { t?: number }).t = window.setTimeout(() => { p.hidden = true; }, 6000);
}
const act = (p: Promise<unknown>, then: () => void = refresh) => p.then(then, problem);

// ---------- state ----------
let hub: HubState | null = null, registry: SensorEntry[] = [], recordings: Recording[] = [], calib: Calibration = { phase: "idle" };

async function refresh(): Promise<void> {
  try {
    let consumers: Consumer[];
    [hub, registry, consumers] = await Promise.all([api<HubState>("GET", "/api/state"), api<SensorEntry[]>("GET", "/api/registry/sensors"),
                                                    api<Consumer[]>("GET", "/api/consumers")]);
    renderSensors(); renderRecorder(); renderSources(consumers);
  } catch (e) {
    $("subtitle").textContent = `not reachable: ${e instanceof Error ? e.message : e}`;
  }
}

async function refreshSlow(): Promise<void> {
  try {
    recordings = await api<Recording[]>("GET", "/api/recordings");
    renderRecordings(); renderTargets();
  } catch { /* shown by refresh() */ }
}

// ---------- sensors ----------
/** the sensor at the world's origin: x = y = yaw = 0 (its pose is then just its height and tilt) */
const atOrigin = (p: Pose) => Math.abs(p.x) < 1e-3 && Math.abs(p.y) < 1e-3 && Math.abs(p.yaw) < 1e-2;
const originTitle = "the world's origin: the point on the floor below this sensor, x along its forward direction, up as this sensor saw the floor. Changing it moves every pose, no recalibration needed.";

const fmtPose = (p: Pose) => `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)} m · yaw ${p.yaw.toFixed(1)}° · pitch ${p.pitch.toFixed(1)}° · roll ${p.roll.toFixed(1)}°`;

/** "world origin" for the sensor that is it, else a button that makes this one it */
function originControl(can: boolean, make: () => void): HTMLElement {
  if (!can) return h("span", { className: "tag", textContent: "world origin", title: originTitle });
  return h("button", { textContent: "Make origin", title: originTitle, onclick: make });
}

function renderSensors(): void {
  const live = new Map((hub?.sensors ?? []).map(s => [s.name, s]));
  const n = hub?.sensors.length ?? 0;
  $("subtitle").textContent = (n ? `${n} live sensor${n > 1 ? "s" : ""}` : "offline: no live sensors") +
    (hub?.recording.active ? " · recording" : "") + (hub?.calibration ? " · calibrating" : "");
  const rows = registry.map((e, k) => {
    const s = live.get(e.name), enabled = h("input", { type: "checkbox", checked: e.enabled !== false, title: "connect to it" });
    enabled.onchange = () => act(api("PUT", `/api/registry/sensors/${encodeURIComponent(e.name)}`, { enabled: enabled.checked }));
    const ip = h("input", { value: e.ip ?? "", size: 15, title: "its address (change: Enter)" });
    ip.onchange = () => act(api("PUT", `/api/registry/sensors/${encodeURIComponent(e.name)}`, { ip: ip.value.trim() }));
    const mount = h("select", {}, ...[["auto", "from the device"], ["upright", "upright"], ["upsidedown", "upside down"]].map(([v, t]) => h("option", { value: v, textContent: t })));
    mount.value = e.mount ?? "auto";
    mount.onchange = () => act(api("PUT", `/api/registry/sensors/${encodeURIComponent(e.name)}`, { mount: mount.value }));
    const del = h("button", { className: "danger", textContent: "Remove", title: "forget this sensor (its pose too)" });
    del.onclick = () => { if (confirm(`Remove sensor ${e.name}? Its pose is forgotten.`)) act(api("DELETE", `/api/registry/sensors/${encodeURIComponent(e.name)}`)); };
    const stream = !s ? h("span", { className: "warn", textContent: e.enabled === false ? "disabled" : "not started" })
      : s.error ? h("span", { className: "bad", textContent: s.error }) : h("span", { className: "good", textContent: `${s.rate.toFixed(1)} Hz` });
    return h("tr", {},
      h("td", {}, h("span", { className: "sw", style: `background:${color(k)}` } as never), enabled, " ", e.name),
      h("td", {}, ip), h("td", {}, mount), h("td", {}, stream),
      h("td", { textContent: s && s.clock.samples ? `${(s.clock.offset_s * 1000).toFixed(1)} ms · ${s.clock.drift_ppm.toFixed(1)} ppm` : "–" }),
      h("td", { textContent: s?.device ? s.device + (s.upside_down ? " (on its head)" : "") : "–" }),
      h("td", { title: e.calibrated ? `calibrated ${e.calibrated}` : "" }, e.pose ? fmtPose(e.pose) : "not calibrated", ...(e.pose ? [" ", originControl(!atOrigin(e.pose),
        () => act(api("POST", "/api/rig/origin", { sensor: e.name })))] : [])),
      h("td", { className: "actions" }, del));
  });
  $("sensors").querySelector("tbody")!.replaceChildren(...(rows.length ? rows : [h("tr", {}, h("td", { colSpan: 8, className: "empty", textContent: "no sensors yet: add one below" }))]));
}

$("addSensor").addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target as HTMLFormElement, d = new FormData(f);
  act(api("POST", "/api/registry/sensors", { name: String(d.get("name")).trim(), ip: String(d.get("ip")).trim(), mount: d.get("mount") }), () => { f.reset(); void refresh(); });
});

// ---------- recording ----------
function renderRecorder(): void {
  const rec = hub?.recording, btn = $<HTMLButtonElement>("recBtn");
  btn.textContent = rec?.active ? "■ Stop" : "● Record";
  btn.classList.toggle("rec", !!rec?.active);
  btn.disabled = !hub?.sensors.length;
  btn.title = hub?.sensors.length ? "record every live sensor (several: one session folder)" : "no live sensor to record";
  $("recInfo").textContent = rec?.active ? `recording ${rec.file} · ${fmtTime(rec.seconds)} · ${rec.scans} scans · ${fmtMB(rec.bytes ?? 0)}` : rec?.error ?? "";
}
$("recBtn").onclick = () => act(api("POST", "/api/record", { action: hub?.recording.active ? "stop" : "start" }), () => { void refresh(); void refreshSlow(); });

function renderRecordings(): void {
  const recFile = hub?.recording.active ? hub.recording.file : null;
  const rows = recordings.map(r => {
    const dl = h("a", { href: `/api/recordings/${encodeURIComponent(r.name)}`, textContent: "Download", download: r.sensors ? `${r.name}.zip` : r.name });
    const del = h("button", { className: "danger", textContent: "Delete", disabled: r.name === recFile });
    del.onclick = () => { if (confirm(`Delete ${r.name} (${fmtMB(r.bytes)})? This cannot be undone.`)) act(api("DELETE", `/api/recordings/${encodeURIComponent(r.name)}`), () => void refreshSlow()); };
    return h("tr", {},
      h("td", { textContent: r.name + (r.name === recFile ? " (recording)" : ""), title: r.error ?? "" }),
      h("td", { textContent: r.error ? "unreadable" : fmtTime(r.seconds) }), h("td", { textContent: fmtMB(r.bytes) }),
      h("td", { textContent: r.sensors?.join(", ") ?? "1" }), h("td", { textContent: r.created ? new Date(r.created * 1000).toLocaleString() : "" }),
      h("td", { className: "actions" }, dl, " ", del));
  });
  $("recordings").querySelector("tbody")!.replaceChildren(...(rows.length ? rows : [h("tr", {}, h("td", { colSpan: 6, className: "empty", textContent: "no recordings yet" }))]));
}

// ---------- calibration ----------
function renderTargets(): void {
  const sel = $<HTMLSelectElement>("calTarget"), was = sel.value;
  const opts = [h("option", { value: "", textContent: "the live sensors" }),
                ...recordings.filter(r => (r.sensors?.length ?? 0) > 1).map(r => h("option", { value: r.name, textContent: `recording ${r.name}` }))];
  sel.replaceChildren(...opts);
  if ([...sel.options].some(o => o.value === was)) sel.value = was;
}

$("calStart").onclick = () => {
  const target = $<HTMLSelectElement>("calTarget").value;
  act(api("POST", "/api/calibration", { action: "start", ...(target ? { recording: target } : {}) }), pollCalibration);
};
$("calCancel").onclick = () => act(api("POST", "/api/calibration", { action: "cancel" }), pollCalibration);
$("calDiscard").onclick = () => act(api("POST", "/api/calibration", { action: "discard" }), pollCalibration);
$("calAccept").onclick = () => act(api("POST", "/api/calibration", { action: "accept" }), () => { void refresh(); void pollCalibration(); });

let shownPoints = "", shownTable = "";
async function pollCalibration(): Promise<void> {
  try { calib = await api<Calibration>("GET", "/api/calibration"); } catch { return; }
  const running = calib.phase === "empty" || calib.phase === "walk", names = calib.result?.map(r => r.name) ?? [];
  $("calStart").hidden = running; $("calCancel").hidden = !running;
  $("calStart").textContent = calib.phase === "done" || calib.phase === "failed" ? "Calibrate again" : "Calibrate";
  const where = calib.target === "live" ? "" : ` (on ${calib.target})`;
  $("calInfo").textContent = calib.phase === "empty" ? `Step 1 of 2${where}: keep the area empty while every sensor learns it… ${calib.seconds ?? 0} s`
    : calib.phase === "walk" ? `Step 2 of 2${where}: walk a wide loop through the area every sensor sees (${(calib.seconds ?? 0).toFixed(0)} s; tracked ${(calib.samples ?? []).join(" / ")}×)` + (calib.ready || calib.solving ? " — solving…" : "")
    : calib.phase === "failed" ? `calibration failed: ${calib.error}`
    : calib.phase === "done" ? `Solved${where}. Check the view below, then use or discard these poses.` + (calib.region ? ` Solved inside the region you drew; ${calib.cut ?? 0} points left out.` : "") : "";
  $("calResult").hidden = calib.phase !== "done";
  if (calib.phase !== "done") { shownPoints = ""; shownTable = ""; return; }
  const sig = JSON.stringify([calib.origin, calib.result]);
  if (sig !== shownTable) {                                  // only when it changed: a click on a button must not meet a fresh row
    shownTable = sig;
  $("calTable").querySelector("tbody")!.replaceChildren(...calib.result!.map((r, k) => h("tr", {},
    h("td", {}, h("span", { className: "sw", style: `background:${color(k)}` } as never), r.name),
    h("td", {}, fmtPose(r.pose), " ", originControl(r.name !== calib.origin, () => act(api("POST", "/api/calibration", { action: "origin", sensor: r.name }), pollCalibration))),
    h("td", { textContent: quality(r.quality, r.name === calib.origin) }),
    h("td", {}, ...(r.problems.length ? r.problems.map(p => h("div", { className: "warn", textContent: p })) : ["–"])))));
  }
  const key = names.join() + JSON.stringify(calib.result!.map(r => r.pose));
  if (key !== shownPoints) {
    shownPoints = key;
    region = calib.region ? calib.region.map(p => [...p] as [number, number]) : []; drawing = false;
    try { points = await api<Points>("GET", "/api/calibration/points"); } catch (e) { problem(e); }
  }
  redraw();
}

// ---------- the region: a polygon on the view from above, outside of which the next solve leaves everything out ----------
let points: Points | null = null, region: Region = [], drawing = false, drag = -1;
let toWorld = (_px: number, _py: number): [number, number] => [0, 0], toPx = (_x: number, _y: number): [number, number] => [0, 0];
const closed = () => !drawing && region.length >= 3;

function redraw(): void {
  if (points) drawPoints(points);
  const sel = calib.region?.length ? calib.region : null;
  $("calRegionDraw").textContent = drawing ? "Cancel drawing" : region.length ? "Draw again" : "Draw region";
  $("calRegionClear").hidden = !region.length;
  const solve = $("calResolve");
  solve.hidden = !(closed() || (!region.length && sel));
  solve.textContent = closed() ? "Solve again inside the region" : "Solve again without the region";
}

/** where the pointer is on the canvas, in canvas pixels */
const canvasPx = (cv: HTMLCanvasElement, e: PointerEvent): [number, number] => {
  const r = cv.getBoundingClientRect();
  return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height];
};
const vertexAt = (px: number, py: number): number => region.findIndex(v => { const [x, y] = toPx(v[0], v[1]); return Math.hypot(x - px, y - py) <= 9 * (devicePixelRatio || 1); });

{
  const cv = $<HTMLCanvasElement>("calView");
  cv.addEventListener("pointerdown", e => {
    const [px, py] = canvasPx(cv, e);
    if (drawing) {
      if (region.length >= 3 && vertexAt(px, py) === 0) drawing = false;
      else region.push(toWorld(px, py));
      redraw();
    } else if (region.length) {
      drag = vertexAt(px, py);
      if (drag >= 0) cv.setPointerCapture(e.pointerId);
    }
  });
  cv.addEventListener("pointermove", e => {
    if (drag < 0) return;
    region[drag] = toWorld(...canvasPx(cv, e));
    redraw();
  });
  cv.addEventListener("pointerup", () => { drag = -1; });
}
window.addEventListener("keydown", e => { if (e.key === "Escape" && drawing) { drawing = false; region = calib.region?.map(p => [...p] as [number, number]) ?? []; redraw(); } });
$("calRegionDraw").onclick = () => {
  if (drawing) { drawing = false; region = calib.region?.map(p => [...p] as [number, number]) ?? []; }
  else { drawing = true; region = []; }
  redraw();
};
$("calRegionClear").onclick = () => { drawing = false; region = []; redraw(); };
$("calResolve").onclick = () => {
  const body = { action: "resolve", region: closed() ? region : null };
  $<HTMLButtonElement>("calResolve").disabled = true;
  act(api("POST", "/api/calibration", body).finally(() => { $<HTMLButtonElement>("calResolve").disabled = false; }), pollCalibration);
};

function quality(q: Record<string, unknown> | null, origin: boolean): string {
  if (!q) return "–";
  const n = (v: unknown, f: (x: number) => string) => (typeof v === "number" && isFinite(v) ? f(v) : null);
  const parts = [n(q.floor_rms_mm, v => `floor ${v.toFixed(1)} mm`), origin ? "the world's origin" : n(q.walk_rms_cm, v => `walk ${v.toFixed(1)} cm`),
                 n(q.icp_median_mm, v => `scene ${v.toFixed(1)} mm`), n(q.overlap, v => `${(v * 100).toFixed(0)} % overlap`)];
  return parts.filter(Boolean).join(" · ") || "–";
}

/** every sensor's empty scene from above, fitted into the canvas, with a 1 m grid and each sensor's position and heading */
function drawPoints(p: Points): void {
  const cv = $<HTMLCanvasElement>("calView"), g = cv.getContext("2d")!, dpr = devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr; cv.height = cv.clientWidth * 0.58 * dpr;
  const W = cv.width, H = cv.height, cs = getComputedStyle(document.body);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const s of p.sensors) {
    for (let i = 0; i < s.xy.length; i += 2) { x0 = Math.min(x0, s.xy[i]); x1 = Math.max(x1, s.xy[i]); y0 = Math.min(y0, s.xy[i + 1]); y1 = Math.max(y1, s.xy[i + 1]); }
    x0 = Math.min(x0, s.pose.x); x1 = Math.max(x1, s.pose.x); y0 = Math.min(y0, s.pose.y); y1 = Math.max(y1, s.pose.y);
  }
  if (!isFinite(x0)) return;
  const pad = 20 * dpr, scale = Math.min((W - 2 * pad) / Math.max(x1 - x0, 1), (H - 2 * pad) / Math.max(y1 - y0, 1));
  const X = (x: number) => pad + (x - x0) * scale + ((W - 2 * pad) - (x1 - x0) * scale) / 2;
  const Y = (y: number) => H - pad - (y - y0) * scale - ((H - 2 * pad) - (y1 - y0) * scale) / 2;   // y up, as seen from above
  const offX = ((W - 2 * pad) - (x1 - x0) * scale) / 2, offY = ((H - 2 * pad) - (y1 - y0) * scale) / 2;
  toWorld = (px, py) => [(px - pad - offX) / scale + x0, (H - pad - offY - py) / scale + y0];
  toPx = (x, y) => [X(x), Y(y)];
  const cut = closed() ? region : null;
  g.clearRect(0, 0, W, H);
  g.strokeStyle = cs.getPropertyValue("--grid"); g.lineWidth = 1;
  for (let x = Math.ceil(x0); x <= x1; x++) { g.beginPath(); g.moveTo(X(x), 0); g.lineTo(X(x), H); g.stroke(); }
  for (let y = Math.ceil(y0); y <= y1; y++) { g.beginPath(); g.moveTo(0, Y(y)); g.lineTo(W, Y(y)); g.stroke(); }
  p.sensors.forEach((s, k) => {
    g.fillStyle = color(k);
    for (let i = 0; i < s.xy.length; i += 2) {
      g.globalAlpha = cut && !pointInPolygon(s.xy[i], s.xy[i + 1], cut) ? 0.15 : 0.7;
      g.fillRect(X(s.xy[i]) - dpr, Y(s.xy[i + 1]) - dpr, 2 * dpr, 2 * dpr);
    }
    g.globalAlpha = 1;
    const a = s.pose.yaw * Math.PI / 180, px = X(s.pose.x), py = Y(s.pose.y);
    g.beginPath(); g.arc(px, py, 5 * dpr, 0, 2 * Math.PI); g.fill();
    g.strokeStyle = color(k); g.lineWidth = 2 * dpr;
    g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(a) * 22 * dpr, py - Math.sin(a) * 22 * dpr); g.stroke();
    g.fillStyle = cs.getPropertyValue("--text"); g.font = `${12 * dpr}px system-ui`;
    g.fillText(s.name, px + 8 * dpr, py - 8 * dpr);
  });
  if (region.length) {
    g.strokeStyle = cs.getPropertyValue("--text"); g.fillStyle = cs.getPropertyValue("--text"); g.lineWidth = 2 * dpr;
    g.beginPath();
    region.forEach((v, i) => { const [x, y] = toPx(v[0], v[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    if (closed()) { g.closePath(); g.globalAlpha = 0.08; g.fill(); g.globalAlpha = 1; }
    g.stroke();
    region.forEach((v, i) => { const [x, y] = toPx(v[0], v[1]); g.beginPath(); g.arc(x, y, (i === 0 && drawing ? 6 : 4) * dpr, 0, 2 * Math.PI); g.fill(); });
  }
}

// ---------- sources and who watches them ----------
function renderSources(consumers: Consumer[]): void {
  const live = hub?.sensors ?? [], on = (id: string) => consumers.filter(c => c.source === id);
  const who = (list: Consumer[]) => list.length ? h("div", {}, ...list.map(c => h("div", { className: "sub2", title: `connected since ${new Date(c.since * 1000).toLocaleTimeString()}` },
    h("span", { textContent: c.name + (c.registered ? "" : " (anonymous)") }),
    c.owns ? h("span", { className: "tag", textContent: "drives it" }) : "",
    h("span", { className: c.dropped ? "warn" : "muted", textContent: ` · ${c.sent} sent${c.dropped ? ` · ${c.dropped} dropped` : ""}` })))) : h("span", { className: "muted", textContent: "nobody" });
  const rows = [
    h("tr", {},
      h("td", {}, h("strong", { textContent: "Live sensors" })),
      h("td", { textContent: live.length ? live.map(s => s.name).join(", ") : "none (offline)" }),
      h("td", { textContent: live.length ? `${live.filter(s => !s.error && s.rate > 0).length} of ${live.length} streaming` : "–" }),
      h("td", {}, who(on("live")))),
    ...(hub?.replays ?? []).map(r => {
      const p = r.replay, pos = r.mode === "pull" ? `every frame, ${(p.index ?? -1) + 1} of ${r.count} sent`
        : `${fmtTime(p.t)} / ${fmtTime(p.duration)}${p.playing ? (p.speed && p.speed !== 1 ? ` · ${p.speed}×` : "") : " · paused"}`;
      return h("tr", {},
        h("td", {}, h("strong", { textContent: `Replay of ${r.recording}` }), h("div", { className: "sub2 muted", textContent: `${r.mode === "pull" ? "batch (pull)" : "stream"} · started by ${r.owner || "?"} · ${r.id}` })),
        h("td", { textContent: r.sensors.join(", ") }),
        h("td", {}, h("span", { className: r.error ? "bad" : "", textContent: r.error || pos })),
        h("td", {}, who(on(r.id))));
    }),
  ];
  $("sources").querySelector("tbody")!.replaceChildren(...rows);
  const idle = consumers.filter(c => c.source === null);
  $("idle").hidden = !idle.length;
  $("idle").textContent = idle.length ? `Connected, watching nothing yet: ${idle.map(c => c.name).join(", ")}` : "";
}

// ---------- registered processing servers ----------
async function refreshConsumers(): Promise<void> {
  const body = $("consumers").querySelector("tbody")!;
  let list: ConsumerEntry[];
  try { list = await api<ConsumerEntry[]>("GET", "/api/registry/consumers"); } catch (e) {
    body.replaceChildren(h("tr", {}, h("td", { colSpan: 3, className: "empty", textContent: e instanceof Error ? e.message : String(e) })));
    return;
  }
  const rows = list.map(c => {
    const tok = h("input", { value: c.token, readOnly: true, type: "password", size: 26, title: "its token" });
    const show = h("button", { textContent: "Show", onclick: () => { tok.type = tok.type === "password" ? "text" : "password"; show.textContent = tok.type === "password" ? "Show" : "Hide"; } });
    const copy = h("button", { textContent: "Copy", onclick: () => void navigator.clipboard?.writeText(c.token).catch(problem) });
    const del = h("button", { className: "danger", textContent: "Remove", title: "it can no longer connect with this token" });
    del.onclick = () => { if (confirm(`Remove ${c.name}? It can no longer connect with its token.`)) act(api("DELETE", `/api/registry/consumers/${encodeURIComponent(c.name)}`), () => void refreshConsumers()); };
    return h("tr", {}, h("td", { textContent: c.name }), h("td", {}, tok, " ", show, " ", copy), h("td", { className: "actions" }, del));
  });
  body.replaceChildren(...(rows.length ? rows : [h("tr", {}, h("td", { colSpan: 3, className: "empty", textContent: "none registered" }))]));
}

$("addConsumer").addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  act(api("POST", "/api/registry/consumers", { name: String(new FormData(f).get("name")).trim() }), () => { f.reset(); void refreshConsumers(); });
});

// ---------- the server's settings ----------
const token = $<HTMLInputElement>("token");
const settings = new SettingsForm({
  load: () => api<SettingsView>("GET", "/api/settings"),
  save: patch => api<SettingsSaved>("PUT", "/api/settings", patch),
}, {
  follow: !import.meta.env.DEV,              // the Vite dev page stays; its proxy still points at the old address
  onSaved: (_, patch) => {                   // a new admin token: this page uses it from now on
    if (typeof patch.adminToken === "string") { store.set("mrs6000.source.token", patch.adminToken); token.value = patch.adminToken; }
  },
});
$("settings").append(settings.el);

// ---------- start ----------
token.value = store.get("mrs6000.source.token");
token.onchange = () => { store.set("mrs6000.source.token", token.value); void refresh(); void refreshConsumers(); void settings.load(); };
void refresh(); void refreshSlow(); void pollCalibration(); void refreshConsumers(); void settings.load();
setInterval(() => void refresh(), 1000);
setInterval(() => void refreshSlow(), 4000);
setInterval(() => { if (calib.phase === "empty" || calib.phase === "walk" || hub?.calibration) void pollCalibration(); }, 500);
