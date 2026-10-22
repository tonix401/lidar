// The reference client of an object-detection server: one WebSocket (/ws, libs/wire/src/objects.ts) that says hello,
// subscribes to the live sensors or replays a recording, and sends its options (classes, region, rate, trails) as
// they change; every `objects` message redraws the floor map (map.ts). The Server section edits the server itself:
// its settings and its registered clients (HTTP API, with the admin token once the server has one).
import { SettingsForm } from "@mrs6000/web/settingsForm";
import "@mrs6000/web/settingsForm.css";
import { CLASSES, type ClientOptions, type WorldObject } from "@mrs6000/wire/objects";
import type { SettingsSaved, SettingsView } from "@mrs6000/wire/settings";
import { classColor, FloorMap } from "./map";
import { ObjectsModel, type Message } from "./model";
import "./styles.css";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = { get: (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } },
                set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

const model = new ObjectsModel(), map = new FloorMap($<HTMLCanvasElement>("map"));
const options: ClientOptions = { trails: true };
let ws: WebSocket | null = null, region: [number, number][] = [], drafting = false, selected: number | null = null, dirty = true;

// ---------- the connection ----------
function connect(): void {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`, sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    const token = store.get("mrs6000.objects.token");
    sock.send(JSON.stringify({ type: "hello", name: "reference page", ...(token ? { token } : { options }) }));
    sock.send(JSON.stringify({ type: "subscribe", source: "live" }));
    if (token) sendOptions();                      // a registered client starts with its stored options; these replace them
  };
  sock.onmessage = e => {
    const m = JSON.parse(String(e.data)) as Message;
    if (model.apply(m)) dirty = true;
    if (m.type === "subscribed") { map.fit(model.rig, true); renderSource(); }
    if (m.type === "state" || m.type === "closed") renderSource();
    if (m.type === "error" || m.type === "welcome") renderStatus();
  };
  sock.onclose = () => { if (ws === sock) { model.error = "disconnected, retrying…"; renderStatus(); setTimeout(connect, 2000); } };
}

const send = (m: Record<string, unknown>) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const sendOptions = () => send({ type: "options", options: { ...options, ...(region.length >= 3 ? { region } : {}) } });

// ---------- the panel ----------
function renderStatus(): void {
  const w = model.welcome;
  $("status").textContent = model.error ? model.error
    : w ? `${w.server} · ${w.client.registered ? `client ${w.client.name}` : "anonymous"} · ${model.sensors.length} sensor${model.sensors.length === 1 ? "" : "s"}` : "connecting…";
  $("status").classList.toggle("bad", !!model.error);
}

function renderSource(): void {
  const r = model.replay, replaying = model.source !== "live";
  $("transport").hidden = !replaying || !model.owner;
  if (replaying && r) {
    $("play").textContent = r.playing ? "⏸" : "▶";
    $("pos").textContent = `${r.file ?? ""} · ${Math.round(r.t ?? 0)} / ${Math.round(r.duration ?? 0)} s`;
  }
  if (!replaying) $<HTMLSelectElement>("source").value = "live";
  renderStatus();
}

async function loadRecordings(): Promise<void> {
  try {
    const list = await (await fetch("/api/recordings")).json() as { name: string; sensors?: string[]; error?: string }[];
    const sel = $<HTMLSelectElement>("source"), was = sel.value;
    sel.replaceChildren(new Option("live sensors", "live"), ...list.filter(r => !r.error).map(r => new Option(`replay ${r.name}`, r.name)));
    sel.value = [...sel.options].some(o => o.value === was) ? was : "live";
  } catch { /* the list is optional */ }
}

$<HTMLSelectElement>("source").onchange = e => {
  const v = (e.target as HTMLSelectElement).value;
  send(v === "live" ? { type: "subscribe", source: "live" } : { type: "replay", recording: v });
};
$("play").onclick = () => send({ type: "control", action: "toggle" });

$("classes").replaceChildren(...CLASSES.map(c => {
  const box = document.createElement("input");
  box.type = "checkbox"; box.checked = true;
  box.onchange = () => {
    const on = [...$("classes").querySelectorAll<HTMLInputElement>("input")].map((b, i) => (b.checked ? CLASSES[i] : null)).filter(Boolean) as typeof options.classes;
    options.classes = on!.length === CLASSES.length ? undefined : on;
    sendOptions();
  };
  const label = document.createElement("label"), sw = document.createElement("span");
  sw.className = "sw"; sw.style.background = classColor(c);
  label.append(box, sw, c);
  return label;
}));
$<HTMLInputElement>("trails").onchange = e => { options.trails = (e.target as HTMLInputElement).checked; sendOptions(); };
$<HTMLSelectElement>("rate").onchange = e => { const v = (e.target as HTMLSelectElement).value; options.rate = v ? Number(v) : undefined; sendOptions(); };

$("regionBtn").onclick = () => {
  if (!drafting) { drafting = true; map.picking = true; region = []; $("regionBtn").textContent = "Finish region"; }
  else { drafting = false; map.picking = false; $("regionBtn").textContent = "Draw a region"; if (region.length < 3) region = []; sendOptions(); }
  $("regionClear").hidden = !region.length && !drafting;
  dirty = true;
};
$("regionClear").onclick = () => { region = []; drafting = false; map.picking = false; $("regionBtn").textContent = "Draw a region"; $("regionClear").hidden = true; sendOptions(); dirty = true; };

const token = $<HTMLInputElement>("token");
token.value = store.get("mrs6000.objects.token");
token.onchange = () => { store.set("mrs6000.objects.token", token.value.trim()); ws?.close(); };

function span(className: string, text: string): HTMLSpanElement {
  const e = document.createElement("span");
  e.className = className; e.textContent = text;
  return e;
}

function renderList(objs: WorldObject[]): void {
  $("count").textContent = objs.length ? String(objs.length) : "";
  $("list").replaceChildren(...objs.slice(0, 30).map(o => {
    const row = document.createElement("div");
    row.className = "orow" + (o.id === selected ? " sel" : "");
    const sw = span("sw", ""), nm = span("nm", `#${o.id} ${o.cls}`), mt = span("mt", `${o.speed.toFixed(1)} m/s · ${o.age.toFixed(0)} s`);
    sw.style.background = classColor(o.cls);
    row.append(sw, nm, mt);
    row.onclick = () => { selected = o.id === selected ? null : o.id; dirty = true; };
    return row;
  }));
}

// ---------- the map ----------
const canvas = $<HTMLCanvasElement>("map"), tip = $("tip");
canvas.addEventListener("click", e => {
  if (drafting) { region.push(map.toWorld(e.offsetX, e.offsetY)); $("regionClear").hidden = false; dirty = true; return; }
  const o = map.pick(e.offsetX, e.offsetY, model.objects);
  selected = o ? o.id : null; dirty = true;
});
canvas.addEventListener("mousemove", e => {
  const o = map.pick(e.offsetX, e.offsetY, model.objects);
  tip.hidden = !o;
  if (!o) return;
  tip.textContent = `#${o.id} ${o.cls}\n${o.x.toFixed(2)}, ${o.y.toFixed(2)} m · ${o.speed.toFixed(2)} m/s\n${o.box.len.toFixed(2)} × ${o.box.wid.toFixed(2)} m, ${o.box.z0.toFixed(2)}–${o.box.z1.toFixed(2)} m high\nseen by ${o.sensors.join(", ")} · ${o.age.toFixed(1)} s`;
  tip.style.left = `${e.clientX + 14}px`; tip.style.top = `${e.clientY + 14}px`;
});
canvas.addEventListener("mouseleave", () => { tip.hidden = true; });
map.onChange = () => { dirty = true; };
addEventListener("resize", () => { dirty = true; });

let listAt = 0;
function frame(now: number): void {
  if (dirty) {
    dirty = false;
    map.draw(model.rig, model.objects, region, drafting, selected);
    if (now - listAt > 250) { listAt = now; renderList(model.objects); $("rateInfo").textContent = `${model.rate().toFixed(1)} messages/s · ${model.started} tracks started`; }
    else dirty = true;
  }
  requestAnimationFrame(frame);
}

// ---------- the server (Server section) ----------
interface ClientEntry { id: string; name: string; token: string; options: ClientOptions }

async function admin<T>(method: string, path: string, body?: unknown): Promise<T> {
  const tok = store.get("mrs6000.objects.admin"), headers: Record<string, string> = {};
  if (tok) headers.Authorization = `Bearer ${tok}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((out as { error?: string }).error ?? `HTTP ${r.status}`);
  return out as T;
}

const adminToken = $<HTMLInputElement>("adminToken");
const settings = new SettingsForm({
  load: () => admin<SettingsView>("GET", "/api/settings"),
  save: patch => admin<SettingsSaved>("PUT", "/api/settings", patch),
}, {
  follow: !import.meta.env.DEV,              // the Vite dev page stays; its proxy still points at the old address
  onSaved: (_, patch) => {
    if (typeof patch.adminToken === "string") { store.set("mrs6000.objects.admin", patch.adminToken); adminToken.value = patch.adminToken; }
    if ("name" in patch) ws?.close();        // the welcome names the server
  },
});
$("settings").append(settings.el);

async function loadClients(): Promise<void> {
  let list: ClientEntry[];
  try { list = await admin<ClientEntry[]>("GET", "/api/clients"); } catch (e) { $("clients").replaceChildren(span("note bad", e instanceof Error ? e.message : String(e))); return; }
  $("clients").replaceChildren(...(list.length ? list.map(clientRow) : [span("note", "none registered")]));
}

function clientRow(c: ClientEntry): HTMLElement {
  const row = document.createElement("div"), opts = document.createElement("textarea"), err = span("note bad", "");
  row.className = "client";
  opts.rows = 2; opts.spellcheck = false; opts.value = JSON.stringify(c.options);
  opts.onchange = () => {
    let o: unknown;
    try { o = JSON.parse(opts.value); } catch { err.textContent = "not valid JSON"; return; }
    admin("PUT", `/api/clients/${encodeURIComponent(c.id)}`, { options: o }).then(() => { err.textContent = ""; }, e => { err.textContent = e instanceof Error ? e.message : String(e); });
  };
  const copy = document.createElement("button"), del = document.createElement("button");
  copy.type = "button"; copy.textContent = "Copy token"; copy.onclick = () => void navigator.clipboard?.writeText(c.token);
  del.type = "button"; del.textContent = "Remove";
  del.onclick = () => { if (confirm(`Remove client ${c.name}? It can no longer connect with its token.`)) void admin("DELETE", `/api/clients/${encodeURIComponent(c.id)}`).then(loadClients, e => { err.textContent = String(e); }); };
  const head = document.createElement("div");
  head.className = "row"; head.append(span("nm", c.name), copy, del);
  row.append(head, opts, err);
  return row;
}

$("addClient").addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  void admin("POST", "/api/clients", { name: String(new FormData(f).get("name")).trim(), options: {} }).then(() => { f.reset(); void loadClients(); },
    err => { $("clients").prepend(span("note bad", err instanceof Error ? err.message : String(err))); });
});

adminToken.value = store.get("mrs6000.objects.admin");
adminToken.onchange = () => { store.set("mrs6000.objects.admin", adminToken.value.trim()); void settings.load(); void loadClients(); };
$<HTMLDetailsElement>("server").addEventListener("toggle", e => { if ((e.target as HTMLDetailsElement).open) { void settings.load(); void loadClients(); } });

(window as unknown as { objects: unknown }).objects = { model, map };   // for the end-to-end check and the curious
connect();
void loadRecordings();
setInterval(() => void loadRecordings(), 10_000);
requestAnimationFrame(frame);
