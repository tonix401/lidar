// End-to-end: the real backend (offline, replaying a generated recording of a person walking past a
// wall) serving the built frontend, driven in headless Chromium.
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { castRanges, elevations } from "../tests/helpers/scene";
import { browserExecutable, pythonInVenv } from "./browser";

const ROOT = resolve(process.cwd(), "..");
const PYTHON = process.env.PYTHON ?? pythonInVenv(join(ROOT, "backend"));
const L = 24, B = 301, STEP = 0.4;

/** .mrsstream writer (format: backend/src/mrs6000/server/stream.py) */
function writeRecording(path: string, scans: number): void {
  const hdr = { layers: L, beams: B, start_azimuth_deg: -60, step_deg: STEP, upside_down: false,
                elev: elevations(L).flatMap(e => Array(B).fill(e)) };
  const parts: Buffer[] = [Buffer.from(JSON.stringify(hdr) + "\n")];
  for (let k = 0; k < scans; k++) {
    const y = 1.5 - 0.06 * (k % 50);                                 // walks across, again and again
    const d = castRanges({ L, B, step: STEP, noise: 0.01, seed: k + 1, objects: k < 20 ? [] : [{ x: 2.5, y, r: 0.22, z0: -1, z1: 0.9 }] });
    const buf = Buffer.alloc(8 + 4 * L * B);
    buf.writeDoubleLE(1000 + k * 0.1, 0);
    for (let i = 0; i < L * B; i++) { buf.writeUInt16LE(Math.round(d[i] / 0.0125), 8 + 2 * i); buf.writeUInt16LE(100, 8 + 2 * L * B + 2 * i); }
    parts.push(buf);
  }
  writeFileSync(path, Buffer.concat(parts));
}

const freePort = () => new Promise<number>(res => { const s = createServer(); s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

let backend: ChildProcess, browser: Browser, page: Page, base = "", log = "";
const errors: string[] = [];

beforeAll(async () => {
  if (!existsSync("dist/index.html")) execSync("npx vite build", { stdio: "inherit" });
  const dir = mkdtempSync(join(tmpdir(), "mrs6000-e2e-"));
  writeRecording(join(dir, "synthetic.mrsstream"), 120);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  backend = spawn(PYTHON, ["-m", "mrs6000.server", "--offline", "--port", String(port), "--recordings", dir,
                           "--frontend", resolve("dist"), "--replay", join(dir, "synthetic.mrsstream")]);
  backend.stdout!.on("data", d => { log += d; });
  backend.stderr!.on("data", d => { log += d; });
  for (let k = 0; k < 100; k++) {
    try { if ((await fetch(base + "/api/state")).ok) break; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ executablePath: browserExecutable(), args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("response", r => { if (r.status() >= 400 && !r.url().includes("/api/replay")) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + "/");
});

afterAll(async () => {
  await browser?.close();
  backend?.kill();
});

const shot = async (name: string) => { mkdirSync("e2e/artifacts", { recursive: true }); await page.screenshot({ path: `e2e/artifacts/${name}.png` }); };
const appState = <T>(fn: string) => page.evaluate(`(() => { const a = window.mrs6000; return ${fn}; })()`) as Promise<T>;

describe("viewer in a browser", () => {
  it("shows the replay, detects and highlights the walking person", async () => {
    await page.waitForFunction(() => (window as unknown as { mrs6000?: { processor: { objects: { confirmed: unknown[] } | null } } })
      .mrs6000?.processor.objects?.confirmed.length, null, { timeout: 30_000 });
    expect(await page.textContent("#subtitle")).toBe("replaying synthetic.mrsstream");
    expect(await page.isVisible("#transport")).toBe(true);
    expect(await page.textContent("#geom")).toBe("24 × 301");
    await page.waitForSelector("#objList .orow");
    expect(await page.textContent("#objList")).toMatch(/#\d+ (person|moving object|object)/);
    expect(await page.locator(".olabel").count()).toBeGreaterThan(0);
    expect(await appState<number>("a.geo.nt")).toBeGreaterThan(1000);
    await shot("3d");
  });

  it("selects an object from the list", async () => {
    await page.click("#objList .orow");
    expect(await appState<number>("a.selected")).toBeGreaterThan(0);
    expect(await page.locator("#objList .orow.sel").count()).toBe(1);
  });

  it("pauses, steps and seeks the replay", async () => {
    await page.click("#tPlay");
    await page.waitForFunction(() => document.getElementById("tPlay")!.textContent === "▶");
    const before = Number(await page.inputValue("#tSeek"));
    await page.click("#tStepF");
    await page.waitForFunction(b => Number((document.getElementById("tSeek") as HTMLInputElement).value) === b + 1, before);
    await page.locator("#tSeek").fill("10");
    await page.locator("#tSeek").dispatchEvent("change");
    await page.waitForFunction(() => (document.getElementById("tSeek") as HTMLInputElement).value === "10");
    await page.click("#tPlay");
  });

  it("switches between 3D, map and range image", async () => {
    await page.click('[data-mode="top"]');
    expect(await page.isVisible("#view2d")).toBe(true);
    expect(await page.isHidden("#view")).toBe(true);
    await shot("map");
    await page.click('[data-mode="image"]');
    await page.mouse.move(800, 60);
    await shot("range-image");
    await page.click('[data-mode="3d"]');
    expect(await page.isVisible("#view")).toBe(true);
  });

  it("changes settings: preset, colour, object toggles", async () => {
    await page.selectOption("#mode", "manual");
    await page.selectOption("#preset", "strong");
    expect(await appState<number>("a.cfg.temporal.window")).toBe(30);
    await page.selectOption("#colorBy", "height");
    await page.uncheck("#oBoxes");
    expect(await appState<boolean>("a.ui.boxes")).toBe(false);
    await page.check("#oBoxes");
    await page.selectOption("#mode", "auto");
  });

  it("goes back to live (offline: nothing to record) and lists the recording", async () => {
    await page.click("#tLive");
    await page.waitForFunction(() => document.getElementById("transport")!.hidden);
    expect(await page.isDisabled("#recBtn")).toBe(true);
    expect(await page.textContent("#srcLabel")).toBe("offline (no sensor)");
    expect(await page.textContent("#recList")).toContain("synthetic");
    await page.click("#recList .rrow");                       // play it again from the list
    await page.waitForFunction(() => !document.getElementById("transport")!.hidden);
  });

  it("had no errors in the page or the backend", () => {
    expect(errors).toEqual([]);
    expect(log).not.toMatch(/Traceback|crashed|http (GET|POST)/);
  });
});
