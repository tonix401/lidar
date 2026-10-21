// End-to-end with several sensors: the real backend replays a simulated 3-sensor session (processing/sim/
// session.ts); in the page, the sensors are listed, Calibrate finds their poses from the empty scene and one
// walk, Accept stores them in the session, and the walker is one fused object.
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compose, fromParams, invert, poseError, type PoseParams } from "@mrs6000/processing/fusion/pose";
import { RIG3, ROOM } from "@mrs6000/processing/sim/rig";
import { writeSession } from "@mrs6000/processing/sim/session";
import { browserExecutable, serverCommand } from "./browser";

const ROOT = resolve(process.cwd(), "..");
const SERVER = serverCommand(ROOT);
const freePort = () => new Promise<number>(res => { const s = createServer(); s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

let backend: ChildProcess, browser: Browser, page: Page, dir = "", log = "";
const errors: string[] = [];

beforeAll(async () => {
  if (!existsSync("dist/index.html")) execSync("bun --bun x vite build", { stdio: "inherit" });
  dir = mkdtempSync(join(tmpdir(), "mrs6000-rig-"));
  writeSession(join(dir, "sim_rig3"), RIG3.map((s, k) => ({ ...s, B: 181, noise: 0.01, seed: k + 1 })), ROOM, 50);
  const port = await freePort();
  backend = spawn(SERVER[0], [...SERVER.slice(1), "--offline", "--port", String(port), "--recordings", dir,
                           "--frontend", resolve("dist"), "--replay", join(dir, "sim_rig3")]);
  backend.stdout!.on("data", d => { log += d; });
  backend.stderr!.on("data", d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let k = 0; k < 100; k++) {
    try { if ((await fetch(base + "/api/state")).ok) break; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ executablePath: browserExecutable(), args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
  page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.goto(base + "/");
});

afterAll(async () => {
  await browser?.close();
  backend?.kill();
});

const shot = async (name: string) => { mkdirSync("e2e/artifacts", { recursive: true }); await page.screenshot({ path: `e2e/artifacts/${name}.png` }); };

describe("several sensors in a browser", () => {
  it("lists the session's sensors", async () => {
    await page.waitForSelector("#secSensors:not([hidden])");
    await page.waitForFunction(() => document.querySelectorAll("#sensorList .orow").length === 3);
    expect(await page.textContent("#sensorList")).toMatch(/a.*b.*c/s);
    expect(await page.textContent("#subtitle")).toBe("replaying sim_rig3");
  });

  it("calibrates from the empty scene and one walk, and stores the poses", async () => {
    await page.click("#tPlay");                                 // restart from the empty scene, paused...
    // fill fires input and change, so that is the seek; another change event would seek back to wherever a
    // frame still in flight set the slider. Paused, the seek shows its one frame: the first sensor's.
    await page.locator("#tSeek").fill("0");
    await page.waitForFunction(() => (window as unknown as { mrs6000: { sensors: { meta: { replay?: { index: number } } | null }[] } })
      .mrs6000.sensors[0].meta?.replay?.index === 0);
    await page.click("#calStart");                             // ...and calibrate while it plays
    await page.click("#tPlay");
    await page.waitForFunction(() => /Step 2 of 2/.test(document.getElementById("calInfo")!.textContent!), null, { timeout: 30_000 });
    await page.waitForSelector("#calActions:not([hidden])", { timeout: 80_000 });
    await shot("rig-calibrated");
    await page.click("#calAccept");
    await page.waitForFunction(() => /calibrated/.test(document.getElementById("sensorList")!.textContent!));
    const meta = JSON.parse(readFileSync(join(dir, "sim_rig3", "session.json"), "utf8")) as
      { rig: { sensors: { name: string; pose: PoseParams }[] }; truth: { name: string; pose: PoseParams }[] };
    const first = meta.truth[0].pose, world = invert(fromParams({ ...first, z: 0, pitch: 0, roll: 0 }));   // a's levelled frame
    for (const s of meta.rig.sensors) {
      const truth = compose(world, fromParams(meta.truth.find(t => t.name === s.name)!.pose));
      const e = poseError(fromParams(s.pose), truth);
      expect(e.dist, s.name).toBeLessThan(0.05);
      expect(e.angle, s.name).toBeLessThan(0.5);
    }
  });

  it("shows the walker as one object made of all sensors' points", async () => {
    await page.waitForFunction(() => document.querySelectorAll("#objList .orow").length === 1, null, { timeout: 30_000 });
    for (let k = 0; k < 10; k++) {                             // over a second of the walk
      expect(await page.locator("#objList .orow").count()).toBe(1);
      await page.waitForTimeout(100);
    }
    const sensors = await page.evaluate(() => (window as unknown as { mrs6000: { fusion: { objects: { sensors: number[] }[] } } }).mrs6000.fusion.objects[0]?.sensors.length ?? 0);
    expect(sensors).toBeGreaterThanOrEqual(2);
    // the sensors' new scans are drawn together: each burst of geometry updates holds every sensor
    const bursts = await page.evaluate(async () => {
      const a = (window as unknown as { mrs6000: { scene: { update: (g: unknown, k: number) => void } } }).mrs6000;
      const log: [number, number][] = [], orig = a.scene.update.bind(a.scene);
      a.scene.update = (g, k) => { log.push([performance.now(), k]); orig(g, k); };
      await new Promise(r => setTimeout(r, 3000));
      a.scene.update = orig;
      const groups: Set<number>[] = [];
      let last = -Infinity;
      for (const [t, k] of log) { if (t - last > 30) groups.push(new Set()); groups[groups.length - 1].add(k); last = t; }   // sets are ~100 ms apart
      return groups.map(g => g.size);
    });
    expect(bursts.length).toBeGreaterThan(15);                // ~10 sets/s
    expect(bursts.filter(n => n === 3).length / bursts.length).toBeGreaterThan(0.9);
    // where the sensors see the same walls, each spot is drawn once (fusion/surfaces.ts)
    const merged = await page.evaluate(() => (window as unknown as { mrs6000: { sensors: { merge: { shared: number; hidden: number } | null }[] } })
      .mrs6000.sensors.map(v => [v.merge?.shared ?? 0, v.merge?.hidden ?? 0]));
    for (const [shared, hidden] of merged) { expect(shared).toBeGreaterThan(100); expect(hidden).toBeGreaterThan(0); }
    expect(merged.reduce((s, [, hidden]) => s + hidden, 0)).toBeGreaterThan(100);   // c overlaps least: ~12 of its beams
    await page.selectOption("#colorBy", "sensor");
    await shot("rig-fused");
    expect(errors).toEqual([]);
  });
});
