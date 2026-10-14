// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, STAGES } from "../src/config/config";
import { Tracker } from "../src/objects/tracker";
import { renderDevice } from "../src/ui/devicePanel";
import { $ } from "../src/ui/dom";
import { ObjectsPanel } from "../src/ui/objectsPanel";
import { RecordingPanel } from "../src/ui/recordingPanel";
import { StageControls } from "../src/ui/stageControls";
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
  it("generates a control per parameter, puts objects in their section, hides auto stages in auto", () => {
    const change = vi.fn();
    const sc = new StageControls({ default: $("stages"), objects: $("objStage") }, { change, resetCalibration: vi.fn(), extraOpened: vi.fn() });
    const n = STAGES.reduce((s, st) => s + st.params.length + (st.toggle ? 1 : 0), 0);
    expect(document.querySelectorAll("#stages input, #objStage input").length).toBe(n);
    expect($("objStage").querySelector('[data-key="objects"]')).not.toBeNull();
    const cfg = defaultConfig();
    sc.sync(cfg, true);
    const section = (key: string) => document.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
    expect(section("temporal").hidden).toBe(true);
    expect(section("objects").hidden).toBe(false);              // user stages
    expect(section("intensity").hidden).toBe(false);
    sc.sync(cfg, false);
    expect(section("temporal").hidden).toBe(false);
    expect($("cfg-objects-learn-val").textContent).toBe("20 s");
    const inp = $("cfg-objects-gate") as HTMLInputElement;
    inp.value = "1.2"; inp.dispatchEvent(new Event("input"));
    expect(change).toHaveBeenCalledWith("objects", "gate", 1.2);
  });
});

describe("panels", () => {
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
    panel.apply({ ...st, source: "live", sensor: false, recording: { active: false, error: "" } });
    expect($("transport").hidden).toBe(true);
    expect(($("recBtn") as HTMLButtonElement).disabled).toBe(true);
    expect($("srcLabel").textContent).toBe("offline (no sensor)");
  });
});
