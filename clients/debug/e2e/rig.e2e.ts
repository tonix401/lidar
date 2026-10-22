// End-to-end with several sensors: the debug server replays a simulated 3-sensor session (libs/processing/sim/
// session.ts) from the source server; in the page, the sensors are listed, the source server calibrates them from
// the empty scene and one walk (as its page does), the page picks up the poses, and the walker is one fused object.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compose, fromParams, invert, poseError } from "@mrs6000/processing/fusion/pose";
import { RIG3, ROOM } from "@mrs6000/processing/sim/rig";
import { readTpcHeader, writeSession } from "@mrs6000/processing/sim/session";
import { browserExecutable, startServers } from "./browser";

const ROOT = resolve(process.cwd(), "../..");

let servers: Awaited<ReturnType<typeof startServers>>, browser: Browser, page: Page, dir = "";
const errors: string[] = [];

beforeAll(async () => {
  if (!existsSync("dist/index.html")) execSync("bun --bun x vite build", { stdio: "inherit" });
  dir = mkdtempSync(join(tmpdir(), "mrs6000-rig-"));
  writeSession(join(dir, "sim_rig3"), RIG3.map((s, k) => ({ ...s, B: 181, noise: 0.01, seed: k + 1 })), ROOM, 50);
  servers = await startServers(ROOT, dir, "sim_rig3");
  const base = servers.base;
  browser = await chromium.launch({ executablePath: browserExecutable(), args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
  page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.goto(base + "/");
});

afterAll(async () => {
  await browser?.close();
  servers?.stop();
});

const shot = async (name: string) => { mkdirSync("e2e/artifacts", { recursive: true }); await page.screenshot({ path: `e2e/artifacts/${name}.png` }); };

describe("several sensors in a browser", () => {
  it("lists the session's sensors", async () => {
    await page.waitForSelector("#secSensors:not([hidden])");
    await page.waitForFunction(() => document.querySelectorAll("#sensorList .orow").length === 3);
    expect(await page.textContent("#sensorList")).toMatch(/a.*b.*c/s);
    expect(await page.textContent("#subtitle")).toBe("replaying sim_rig3");
  });

  it("the source server calibrates the recording; the page picks up the poses", async () => {
    const call = async (method: string, path: string, body?: unknown) => (await fetch(servers.source + path, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) })).json() as Promise<any>;
    expect((await call("POST", "/api/calibration", { action: "start", recording: "sim_rig3" })).phase).toBe("empty");
    for (let k = 0; k < 900 && !["done", "failed"].includes((await call("GET", "/api/calibration")).phase); k++) await page.waitForTimeout(100);
    expect((await call("GET", "/api/calibration")).phase).toBe("done");
    await call("POST", "/api/calibration", { action: "accept" });
    await page.waitForFunction(() => /calibrated/.test(document.getElementById("sensorList")!.textContent!), null, { timeout: 10_000 });
    await shot("rig-calibrated");
    const hdrs = ["a", "b", "c"].map(n => readTpcHeader(join(dir, "sim_rig3", `${n}.tpc`)));   // each file's header: its pose, its truth
    const world = invert(fromParams({ ...hdrs[0].truth!, z: 0, pitch: 0, roll: 0 }));               // a's levelled frame
    for (const h of hdrs) {
      const e = poseError(fromParams(h.rig!.pose!), compose(world, fromParams(h.truth!)));
      expect(e.dist, h.sensor).toBeLessThan(0.05);
      expect(e.angle, h.sensor).toBeLessThan(0.5);
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
