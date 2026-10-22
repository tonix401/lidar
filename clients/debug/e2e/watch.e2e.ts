// End-to-end: a replay started by another processing server is watched in the viewer. An object-detection client
// replays the simulated 3-sensor session through its object-detection server; the viewer lists that replay under
// "Replays of other servers", watches it (the same frames, the transport bar only showing the position, since the
// object-detection client drives it), and falls back to live when that client leaves.
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toParams } from "@mrs6000/processing/fusion/pose";
import { RIG3, ROOM } from "@mrs6000/processing/sim/rig";
import { writeSession } from "@mrs6000/processing/sim/session";
import { seedDb } from "@mrs6000/server-common/testing";
import { browserExecutable, freePort, startServers } from "./browser";

const ROOT = resolve(process.cwd(), "../..");

let servers: Awaited<ReturnType<typeof startServers>>, objects: ChildProcess, browser: Browser, page: Page, client: WebSocket;
const errors: string[] = [], got: { type: string; [k: string]: unknown }[] = [];

beforeAll(async () => {
  if (!existsSync("dist/index.html")) execSync("bun --bun x vite build", { stdio: "inherit" });
  const dir = mkdtempSync(join(tmpdir(), "mrs6000-watch-"));
  writeSession(join(dir, "walk"), RIG3.map((s, k) => ({ ...s, B: 181, noise: 0.01, seed: k + 1 })), ROOM, 40);
  servers = await startServers(ROOT, dir);
  await fetch(`${servers.source}/api/rig?recording=walk`, {                    // as if calibrated
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sensors: RIG3.map(r => ({ name: r.name, pose: toParams(r.pose), calibrated: "test" })) }),
  });
  const port = await freePort(), db = join(mkdtempSync(join(tmpdir(), "objects-db-")), "lobby.db");
  seedDb(db, { port, source: { url: servers.source, token: "" }, cache: join(dir, "cache") });
  objects = spawn(process.env.BUN ?? "bun", [join(ROOT, "proc-servers/object-detection/src/main.ts"), "--db", db]);
  for (let k = 0; k < 100; k++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/state`)).ok) break; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  client = new WebSocket(`ws://127.0.0.1:${port}/ws`);                        // the object-detection client
  client.onmessage = e => got.push(JSON.parse(String(e.data)));
  await new Promise(r => { client.onopen = r; });
  client.send(JSON.stringify({ type: "hello", name: "lobby display" }));
  client.send(JSON.stringify({ type: "replay", recording: "walk" }));
  for (let k = 0; k < 100 && !got.some(m => m.type === "subscribed"); k++) await new Promise(r => setTimeout(r, 100));
  browser = await chromium.launch({ executablePath: browserExecutable(), args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
  page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.goto(servers.base + "/");
});

afterAll(async () => {
  client?.close();
  await browser?.close();
  objects?.kill();
  servers?.stop();
});

const shot = async (name: string) => { mkdirSync("e2e/artifacts", { recursive: true }); await page.screenshot({ path: `e2e/artifacts/${name}.png` }); };

describe("watching another server's replay", () => {
  it("lists the object-detection server's replay and watches it", async () => {
    await page.waitForSelector("#otherHead:not([hidden])", { timeout: 20_000 });
    expect(await page.textContent("#otherList")).toMatch(/^walklobby · /);
    await page.click("#otherList .rrow");
    await page.waitForFunction(() => !document.getElementById("transport")!.hidden);
    await page.waitForFunction(() => document.querySelectorAll("#sensorList .orow").length === 3);
    expect(await page.textContent("#tOwner")).toBe("watching lobby's replay");
    expect(await page.isDisabled("#tPlay")).toBe(true);
    expect(await page.isDisabled("#tSeek")).toBe(true);
    await page.waitForFunction(() => /calibrated/.test(document.getElementById("sensorList")!.textContent!));   // the recording's rig
    await shot("watching");
  });

  it("follows the owner's timeline", async () => {
    client.send(JSON.stringify({ type: "control", action: "pause" }));
    client.send(JSON.stringify({ type: "control", action: "seek", value: 30 }));
    await page.waitForFunction(() => (document.getElementById("tSeek") as HTMLInputElement).value === "30", null, { timeout: 10_000 });
    await page.keyboard.press("Space");                         // the page does not drive it: still paused there
    await page.waitForTimeout(500);
    expect(await page.textContent("#tPlay")).toBe("▶");
  });

  it("goes back to live when the replay's owner leaves", async () => {
    client.close();
    await page.waitForFunction(() => document.getElementById("transport")!.hidden, null, { timeout: 15_000 });
    expect(await page.textContent("#srcLabel")).toBe("offline (no sensor)");
    await page.waitForSelector("#otherHead", { state: "hidden", timeout: 10_000 });   // the list is polled too
    expect(errors.filter(e => !/HTTP 404/.test(e) && !/404 \(Not Found\)/.test(e))).toEqual([]);   // the ended session's last polls
  });
});
