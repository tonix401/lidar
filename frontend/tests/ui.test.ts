// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, STAGES } from "../src/config/config";
import { Tracker } from "../src/objects/tracker";
import { deviceSummary, renderDevice } from "../src/ui/devicePanel";
import { $ } from "../src/ui/dom";
import { ObjectsPanel } from "../src/ui/objectsPanel";
import { RecordingPanel } from "../src/ui/recordingPanel";
import { StageControls } from "../src/ui/stageControls";
import { StatsPanel } from "../src/ui/statsPanel";
import { applyViews } from "../src/ui/views";
import { applyTheme, hexRGB, themeColors } from "../src/ui/theme";
import { DIM_BACKGROUND, ObjectDetector } from "../src/objects/detector";
import type { ServerState } from "../src/core/types";

beforeEach(() => {
  const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script"));
});

describe("index.html", () => {
  it("has every element the code looks up", () => {
    const src = ["app.ts", "ui/recordingPanel.ts", "ui/devicePanel.ts"].map(f => readFileSync(resolve(process.cwd(), "src", f), "utf8")).join("\n");
    const ids = [...src.matchAll(/\$(?:<[^>]+>)?\("([\w-]+)"\)/g)].map(m => m[1]);
    expect(ids.length).toBeGreaterThan(40);
    for (const id of new Set(ids)) expect(document.getElementById(id), id).not.toBeNull();
  });
});

describe("stage controls", () => {
  it("generates a control per parameter, puts objects in their section, shows auto stages read-only in auto", () => {
    const change = vi.fn(), resetStage = vi.fn();
    const sc = new StageControls({ default: $("stages"), objects: $("objStage"), display: $("meshStage") }, { change, resetStage, resetCalibration: vi.fn(), extraOpened: vi.fn() });
    const n = STAGES.reduce((s, st) => s + st.params.length + (st.toggle ? 1 : 0), 0);
    expect(document.querySelectorAll("#stages input, #objStage input, #meshStage input").length).toBe(n);
    expect($("objStage").querySelector('[data-key="objects"]')).not.toBeNull();
    expect($("meshStage").querySelector<HTMLElement>('[data-key="mesh"]')!.dataset.views).toBe("3d top");
    const cfg = defaultConfig();
    sc.sync(cfg, true);
    const section = (key: string) => document.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
    const input = (id: string) => $<HTMLInputElement>(id);
    expect(section("temporal").hidden).toBe(false);              // visible, but read-only
    expect(section("temporal").classList.contains("auto")).toBe(true);
    expect(input("cfg-temporal-window").disabled && input("cfg-temporal-on").disabled).toBe(true);
    expect(input("cfg-outline-on").disabled).toBe(false);        // the user's switch, auto-tuned margin
    expect(input("cfg-outline-margin").disabled).toBe(true);
    expect(input("cfg-objects-gate").disabled).toBe(false);      // user stages
    sc.sync(cfg, false);
    expect(section("temporal").classList.contains("auto")).toBe(false);
    expect($("cfg-objects-learn-val").textContent).toBe("20 s");
    const inp = input("cfg-objects-gate");
    inp.value = "1.2"; inp.dispatchEvent(new Event("input"));
    expect(change).toHaveBeenCalledWith("objects", "gate", 1.2);
  });

  it("marks changes from the defaults and resets one stage", () => {
    const resetStage = vi.fn();
    const sc = new StageControls({ default: $("stages"), objects: $("objStage"), display: $("meshStage") }, { change: vi.fn(), resetStage, resetCalibration: vi.fn(), extraOpened: vi.fn() });
    const cfg = defaultConfig(), section = (key: string) => document.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
    sc.sync(cfg, false);
    expect(document.querySelectorAll(".is-changed").length).toBe(0);
    cfg.temporal.window = 25;
    sc.sync(cfg, false);
    expect(section("temporal").classList.contains("is-changed")).toBe(true);
    expect($("cfg-temporal-window").closest(".param")!.classList.contains("is-changed")).toBe(true);
    expect($("cfg-temporal-k").closest(".param")!.classList.contains("is-changed")).toBe(false);
    const reset = section("temporal").querySelector<HTMLButtonElement>("button.reset")!;
    expect(reset.hidden).toBe(false);
    expect(section("spatial").querySelector<HTMLButtonElement>("button.reset")!.hidden).toBe(true);
    reset.click();
    expect(resetStage).toHaveBeenCalledWith("temporal");
    sc.sync(cfg, true);                                          // auto chose it: no "changed" marker
    expect(section("temporal").classList.contains("is-changed")).toBe(false);
  });

  it("click a value to type an exact number: in display units, clamped, Esc cancels", () => {
    const change = vi.fn();
    const sc = new StageControls({ default: $("stages"), objects: $("objStage"), display: $("meshStage") }, { change, resetStage: vi.fn(), resetCalibration: vi.fn(), extraOpened: vi.fn() });
    sc.sync(defaultConfig(), false);
    const type = (id: string, v: string, key = "Enter") => {
      $(id).click();
      const f = $(id).parentElement!.querySelector<HTMLInputElement>("input.pedit")!;
      f.value = v; f.dispatchEvent(new KeyboardEvent("keydown", { key }));
    };
    type("cfg-objects-gate-val", "0.83");
    expect(change).toHaveBeenLastCalledWith("objects", "gate", 0.83);        // between slider steps
    type("cfg-temporal-noiseFloor-val", "17.5");                            // typed in mm
    expect(change).toHaveBeenLastCalledWith("temporal", "noiseFloor", 0.0175);
    type("cfg-outlier-rel-val", "2.5");                                     // typed in % of range
    expect(change).toHaveBeenLastCalledWith("outlier", "rel", 0.025);
    type("cfg-temporal-window-val", "999");                                 // clamped, whole scans
    expect(change).toHaveBeenLastCalledWith("temporal", "window", 60);
    change.mockClear();
    type("cfg-objects-gate-val", "1.5", "Escape");
    expect(change).not.toHaveBeenCalled();
    expect($("cfg-objects-gate-val").hidden).toBe(false);
    expect(document.querySelector("input.pedit")).toBeNull();
  });
});

describe("theme", () => {
  it("sets data-theme, reads colours, parses hex", () => {
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(themeColors().bg).toMatch(/^#/);                     // a fallback without the stylesheet
    expect(hexRGB("#ff8000")).toEqual([1, 128 / 255, 0]);
    expect(hexRGB("rgb(1,2,3)")).toBeNull();
    applyTheme("dark");
  });

  it("dims the background towards black, or towards a light background", () => {
    const det = new ObjectDetector(4);
    Object.defineProperty(det, "hasConfirmed", { get: () => true });
    const c: [number, number, number] = [0.5, 0.2, 0.8];
    expect(det.tintBackground(c, { dimBackground: true })).toEqual(c.map(v => v * DIM_BACKGROUND));
    const light = det.tintBackground(c, { dimBackground: true, dimTo: [1, 1, 1] });
    for (let k = 0; k < 3; k++) expect(light[k]).toBeGreaterThan(c[k]);    // paler, not darker
    expect(det.tintBackground(c, { dimBackground: false, dimTo: [1, 1, 1] })).toBe(c);
  });
});

describe("view-specific controls", () => {
  it("shows only what changes something in the current view", () => {
    const off = (id: string) => $(id).closest(".offview") !== null;
    applyViews($("panel"), "3d", "surface+points");
    expect(off("cam3d")).toBe(false);
    expect(off("fillWalls")).toBe(false);
    expect(off("fit2d")).toBe(true);
    applyViews($("panel"), "top", "surface+points");
    expect(off("cam3d")).toBe(true);
    expect(off("fillWalls")).toBe(true);
    expect(off("range") || off("size") || off("layerSel")).toBe(false);
    expect(off("fit2d")).toBe(false);
    applyViews($("panel"), "image", "surface+points");
    for (const id of ["draw", "range", "size", "layerSel", "oTrails", "oFollow", "meshStage"]) expect(off(id), id).toBe(true);
    for (const id of ["colorBy", "oBoxes", "oLabels", "oHighlight", "mode", "stages"]) expect(off(id), id).toBe(false);
    applyViews($("panel"), "3d", "surface");
    expect(off("size")).toBe(true);                            // no points drawn
    applyViews($("panel"), "3d", "points");
    expect(off("size")).toBe(false);
    expect(off("meshStage")).toBe(true);                       // no surface or lines
    applyViews($("panel"), "3d", "vlines");
    expect(off("size")).toBe(true);
    expect(off("meshStage")).toBe(false);
  });
});

describe("panels", () => {
  it("statistics: grouped rows updated in place, empty groups hidden", () => {
    const sp = new StatsPanel($("statsList"), ["Timing", "Objects"]);
    sp.render({ Timing: [["Processing", "12 ms", "one scan"]], Objects: [] });
    const rows = () => Array.from($("statsList").querySelectorAll<HTMLElement>(".row")).filter(r => !r.hidden);
    expect(rows().map(r => r.textContent)).toEqual(["Processing i12 ms"]);
    const row = rows()[0];
    sp.render({ Timing: [["Processing", "9 ms"]], Objects: [["Objects", "1 (1 person)"]] });
    expect(rows()[0]).toBe(row);                                // same element: its tooltip stays
    expect(row.querySelector<HTMLElement>(".info")!.dataset.tip).toBe("one scan");
    expect(rows().map(r => r.textContent)).toEqual(["Processing i9 ms", "Objects1 (1 person)"]);
    sp.render({ Timing: [] });
    expect(rows()).toEqual([]);
    expect(Array.from($("statsList").children).every(g => (g as HTMLElement).hidden)).toBe(true);
  });

  it("collapsed device status", () => {
    expect(deviceSummary({ sensor: true, live_error: "" })).toEqual({ text: "connected", dot: "ok" });
    expect(deviceSummary({ sensor: true, live_error: "timeout" })).toEqual({ text: "disconnected", dot: "err" });
    expect(deviceSummary({ sensor: false, live_error: "" }).text).toBe("no sensor (offline)");
  });


  it("object list rows select on click", () => {
    const sel = vi.fn(), t = new Tracker(), c = defaultConfig().objects;
    const det = { segments: [], n: 50, x: 2, y: 0, z: 0, bx: 2, by: 0, len: 0.4, wid: 0.3, hgt: 1.2, yaw: 0, z0: -1, z1: 0.2, l0: 0, l1: 5, b0: 0, b1: 5, clipped: false };
    for (let k = 0; k < 3; k++) t.update([{ ...det, x: 2 + k * 0.1 }], 0.1, c);
    new ObjectsPanel($("objInfo"), $("objList"), sel).render(t.tracks, 0, "1 object");
    expect($("objInfo").textContent).toBe("1 object");
    const row = $("objList").querySelector(".orow") as HTMLElement;
    expect(row.textContent).toContain("#1");
    row.click();
    expect(sel).toHaveBeenCalledWith(1);
  });

  it("device panel", () => {
    renderDevice({ CommonDeviceStatus: { Status: 3 }, KM_SysBoard_Temp: 41.5, KM_APDBoard_Temp: 35, KM_PowerSource_Voltage: 12.2,
                   KM_MotorRotationPeriod: 100, KMWindowWarning: false, KMWindowError: false });
    expect($("devStatus").textContent).toBe("normal");
    expect($("mirror").textContent).toBe("10.00 Hz");
    expect($("window").textContent).toBe("clean");
    renderDevice({});
    expect($("devStatus").textContent).toBe("–");
  });

  it("recording panel: record button, transport, list", async () => {
    const api = { record: vi.fn(), control: vi.fn(), live: vi.fn(), replay: vi.fn(), deleteRecording: vi.fn(),
                  recordings: vi.fn(async () => [{ name: "a.mrsstream", bytes: 5e6, scans: 10, seconds: 65, created: 0 }]),
                  downloadUrl: (n: string) => "/api/recordings/" + n };
    const panel = new RecordingPanel(api as never, { state: vi.fn(), error: vi.fn(), confirm: () => true });
    const st: ServerState = { source: "replay", epoch: 2, live_error: "", replay_error: "", sensor: true,
      recording: { active: true, file: "rec.mrsstream", scans: 20, bytes: 2e6, seconds: 2 },
      replay: { file: "a.mrsstream", index: 4, count: 10, t: 0.4, duration: 1, playing: true, speed: 1, loop: true, upside_down: null } };
    panel.apply(st);
    expect($("recBtn").textContent).toBe("■ Stop");
    expect($("transport").hidden).toBe(false);
    expect(($("tSeek") as HTMLInputElement).value).toBe("4");
    expect($("tTime").textContent).toBe("0:00 / 0:01");
    await vi.waitFor(() => expect($("recList").textContent).toContain("1:05"));
    const row = $("recList").querySelector<HTMLElement>(".rrow")!;
    expect(row.querySelector(".nm")!.textContent).toBe("a");      // name only: no play icon, no size
    expect(row.textContent).not.toContain("MB");
    expect(row.querySelectorAll("button").length).toBe(2);        // play, ⋯
    row.querySelector<HTMLElement>(".more")!.click();
    const menu = document.querySelector<HTMLElement>(".menu")!;
    expect(menu.textContent).toContain("MB · 10 scans");
    expect(menu.querySelector("a")!.getAttribute("href")).toBe("/api/recordings/a.mrsstream");
    api.deleteRecording.mockResolvedValue([]);
    menu.querySelector<HTMLElement>(".danger")!.click();
    expect(api.deleteRecording).toHaveBeenCalledWith("a.mrsstream");
    expect(document.querySelector(".menu")).toBeNull();
    panel.apply({ ...st, source: "live", sensor: false, recording: { active: false, error: "" } });
    expect($("transport").hidden).toBe(true);
    expect(($("recBtn") as HTMLButtonElement).disabled).toBe(true);
    expect($("srcLabel").textContent).toBe("offline (no sensor)");
  });
});
