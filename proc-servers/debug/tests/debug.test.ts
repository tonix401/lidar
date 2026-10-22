// The debug server against a real source server (its own process): a page's replay of a recorded rig over the page's
// API (frames by long-poll with their meta, controls and epochs, state), the server's own fused objects, and the guards.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "@mrs6000/processing/config/config";
import { toParams } from "@mrs6000/processing/fusion/pose";
import { RIG3, ROOM } from "@mrs6000/processing/sim/rig";
import { writeSession } from "@mrs6000/processing/sim/session";
import { SettingsDb } from "@mrs6000/server-common/settings";
import { SourceConnection } from "@mrs6000/server-common/sourceClient";
import { startSource, type TestSource } from "@mrs6000/server-common/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/http";
import { Hub } from "../src/hub";
import { applySettings } from "../src/settings";
import { DEFAULTS, Store } from "../src/store";

let dir = "", source: TestSource, hub: Hub, app: ReturnType<typeof createApp>;
const base = "http://localhost:8010";

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutS = 10): Promise<void> {
  const end = performance.now() + timeoutS * 1000;
  while (!(await cond())) {
    if (performance.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

const call = (path: string, init: RequestInit = {}) => app(new Request(base + path, init));
const getJson = async (path: string) => (await call(path)).json() as Promise<any>;
const post = (path: string, json: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", body: JSON.stringify(json), headers: { "Content-Type": "application/json", ...headers } });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "debug-"));
  writeSession(join(dir, "walk"), RIG3.map((s, k) => ({ ...s, B: 181, noise: 0.01, seed: k + 1 })), ROOM, 14, 1.7e9);
  source = await startSource(dir);
  await fetch(`${source.url}/api/rig?recording=walk`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sensors: RIG3.map(r => ({ name: r.name, pose: toParams(r.pose), calibrated: "test" })) }),
  });
  const cfg = defaultConfig();
  cfg.objects.learn = 2;
  hub = new Hub({ url: source.url, name: "debug-test" }, cfg);
  app = createApp(hub, new Store(null));
}, 30_000);

afterAll(() => { hub?.shutdown(); source?.stop(); });

describe("debug server", () => {
  it("the live view of an offline source: no sensors, no error", async () => {
    await waitUntil(() => hub.live.pipeline.conn.up);
    const st = await getJson("/api/state");
    expect([st.source, st.session, st.sensor, st.live_error]).toEqual(["live", null, false, ""]);
  });

  it("a page's replay: its frames by long-poll, controls, epochs and the server's own objects", { timeout: 30_000 }, async () => {
    const s = await (await post("/api/sessions", { recording: "walk" })).json() as any;
    expect([s.sensors, s.id.length]).toEqual([["a", "b", "c"], 32]);
    const q = `session=${s.id}`;
    const r = await call(`/api/frame?after=0&sensor=b&${q}`), meta = JSON.parse(r.headers.get("X-Meta")!);
    expect([meta.source, meta.sensor, meta.layers, meta.beams, meta.session]).toEqual(["replay", "b", 24, 181, s.id]);
    expect((await r.arrayBuffer()).byteLength).toBe(3 * 24 * 181 * 4);
    expect((await getJson(`/api/rig?${q}`)).sensors.every((e: { pose?: unknown }) => e.pose)).toBe(true);
    expect((await getJson(`/api/sensors?${q}`)).map((x: { name: string; live: boolean }) => [x.name, x.live])).toEqual([["a", false], ["b", false], ["c", false]]);
    await post(`/api/sessions/${s.id}/control`, { action: "speed", value: 4 });
    await waitUntil(async () => ((await getJson(`/api/objects?${q}`)).objects as unknown[]).length > 0, 20);
    expect((await post(`/api/sessions/${s.id}/control`, { action: "pause" })).status).toBe(200);
    await waitUntil(async () => (await getJson(`/api/state?${q}`)).replay.playing === false);
    const before = (await getJson(`/api/state?${q}`)).epoch;
    await post(`/api/sessions/${s.id}/control`, { action: "seek", value: 5 });
    await waitUntil(async () => (await getJson(`/api/state?${q}`)).epoch !== before);
    expect((await getJson(`/api/state?${q}`)).replay.index).toBe(5);
    expect((await call(`/api/sessions/${s.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/api/state?${q}`)).status).toBe(404);
  });

  it("watches another processing server's replay: same frames, its owner's timeline, gone when its owner leaves", { timeout: 30_000 }, async () => {
    let otherFrames = 0;
    const other = new SourceConnection({ url: source.url, name: "lobby" }, { kind: "replay", recording: "walk", mode: "stream" },
                                       { frame: () => { otherFrames++; } });
    await waitUntil(() => otherFrames > 0);
    const list = await getJson("/api/sources");
    expect(list).toMatchObject([{ id: other.source, recording: "walk", owner: "lobby", sensors: ["a", "b", "c"] }]);
    const s = await (await post("/api/sessions", { join: other.source })).json() as any;
    expect([s.owner, s.controls, s.sensors]).toEqual(["lobby", false, ["a", "b", "c"]]);
    const q = `session=${s.id}`;
    const meta = JSON.parse((await call(`/api/frame?after=0&${q}`)).headers.get("X-Meta")!);
    expect([meta.source, meta.session]).toEqual(["replay", s.id]);
    expect(await getJson(`/api/state?${q}`)).toMatchObject({ source: "replay", controls: false, owner: "lobby" });
    const refused = await post(`/api/sessions/${s.id}/control`, { action: "pause" });
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([400, "lobby controls this replay; this page only watches it"]);
    other.control("seek", 7); other.control("pause");                         // its owner drives it
    await waitUntil(async () => (await getJson(`/api/state?${q}`)).replay.index === 7);
    const own = await (await post("/api/sessions", { recording: "walk" })).json() as any;
    expect((await getJson("/api/sources")).map((r: { owner: string }) => r.owner)).toEqual(["lobby"]);   // not its own replays
    await call(`/api/sessions/${own.id}`, { method: "DELETE" });
    other.close();
    await waitUntil(async () => (await call(`/api/state?${q}`)).status === 404);
    expect(await getJson("/api/sources")).toEqual([]);
  });

  it("refuses other web pages; an unknown recording is a short error", async () => {
    expect((await post("/api/sessions", { recording: "walk" }, { Origin: "http://evil.example" })).status).toBe(403);
    const bad = await post("/api/sessions", { recording: "nope" });
    expect(bad.status).toBe(404);
    expect(((await bad.json()) as { error: string }).error).toMatch(/nope/);
    expect((await getJson("/api/recordings")).map((r: { name: string }) => r.name)).toEqual(["walk"]);
  });

  it("the committed empty database is the defaults, and a new one starts as a copy of it", () => {
    const template = join(dirname(fileURLToPath(import.meta.url)), "../empty.db");
    expect(new SettingsDb(template).load()).toEqual(DEFAULTS);                 // scripts/empty-db.ts wrote it
    expect(new Store(join(dir, "fresh.db"), template).data).toEqual(DEFAULTS);
  });

  it("settings: applied at once and saved; a refused one changes nothing", { timeout: 30_000 }, async () => {
    const db = join(dir, "debug.db"), store = new Store(db);
    store.data.source.url = source.url; store.data.name = "settings-test";
    const h = new Hub({ url: source.url, name: "settings-test" }, store.processing), moves: unknown[] = [];
    const listener = { at: { host: "127.0.0.1", port: 8010 }, move(to: { host: string; port: number }) { moves.push(to); this.at = to; } };
    const a = createApp(h, store, null, b => applySettings(h, store, listener, b));
    const put = async (b: unknown) => a(new Request(base + "/api/settings", { method: "PUT", body: JSON.stringify(b), headers: { "Content-Type": "application/json" } }));
    try {
      expect((await (await a(new Request(base + "/api/settings"))).json() as any).values).toMatchObject({ "source.url": source.url, port: 8010, replay: "" });
      expect((await put({ replay: "nope" })).status).toBe(404);                // an unknown recording: nothing changed
      expect([store.data.replay, h.defaultSession]).toEqual(["", null]);
      expect((await put({ replay: "walk", port: 8110 })).status).toBe(200);
      const first = h.defaultSession;
      expect([h.sessions.get(first!)?.recording, moves]).toEqual(["walk", [{ host: "127.0.0.1", port: 8110 }]]);
      expect(new Store(db).data).toMatchObject({ replay: "walk", port: 8110 });
      const before = h.live;
      expect((await put({ name: "renamed", objects: false })).status).toBe(200);   // every view starts afresh, the replay opens again
      expect([h.live === before, h.objects, h.source.name, h.sessions.has(first!), h.defaultSession === null]).toEqual([false, false, "renamed", false, false]);
      await waitUntil(() => h.live.pipeline.conn.up);
      expect((await put({ "source.url": "ftp://x" })).status).toBe(400);
      expect((await put({ replay: "" })).status).toBe(200);
      expect([h.defaultSession, h.sessions.size]).toEqual([null, 0]);
    } finally {
      h.shutdown();
    }
  });
});
