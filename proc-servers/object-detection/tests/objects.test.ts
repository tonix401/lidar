// An object-detection server against a real source server (its own process): an objects client replaying a simulated
// three-sensor walk sees the walker; its options apply; only the replay's owner controls it; strangers are refused
// when the server is closed; a recording's tracks computed in the background serve later replays from the cache.
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "@mrs6000/processing/config/config";
import { toParams } from "@mrs6000/processing/fusion/pose";
import { RIG3, ROOM } from "@mrs6000/processing/sim/rig";
import { writeSession } from "@mrs6000/processing/sim/session";
import { SettingsDb } from "@mrs6000/server-common/settings";
import { startSource, type TestSource } from "@mrs6000/server-common/testing";
import type { WorldObject } from "@mrs6000/wire/objects";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/http";
import { Hub } from "../src/hub";
import { applySettings, cacheRoot, sourceAddress } from "../src/settings";
import { defaults, Store } from "../src/store";
import { Clients, type Conn } from "../src/ws";

const T0 = 1.7e9;
let dir = "", source: TestSource, hub: Hub, store: Store, clients: Clients, server: ReturnType<typeof Bun.serve<Conn>>, url = "", cache = "";
const sockets: WebSocket[] = [];

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutS = 10): Promise<void> {
  const end = performance.now() + timeoutS * 1000;
  while (!(await cond())) {
    if (performance.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "objects-"));
  cache = join(dir, "cache");
  writeSession(join(dir, "walk"), RIG3.map((s, k) => ({ ...s, B: 181, noise: 0.01, seed: k + 1 })), ROOM, 14, T0);
  source = await startSource(dir);
  const put = await fetch(`${source.url}/api/rig?recording=walk`, {               // the true poses, as if calibrated
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sensors: RIG3.map(r => ({ name: r.name, pose: toParams(r.pose), calibrated: "test" })) }),
  });
  expect(put.status).toBe(200);
  store = new Store(null, "test");
  const cfg = defaultConfig();
  cfg.objects.learn = 2;
  hub = new Hub("test", { url: source.url, name: "test" }, cfg, cache);
  hub.start();
  clients = new Clients(hub, store);
  const app = createApp(hub, store, clients);
  server = Bun.serve<Conn>({ port: 0, hostname: "127.0.0.1", websocket: clients.websocket,
                             fetch: (req, srv) => {
                               if (new URL(req.url).pathname !== "/ws") return app(req);
                               const up = clients.upgrade(req, srv);
                               return up === true ? undefined : up === false ? new Response("no", { status: 400 }) : up;
                             } });
  url = `ws://127.0.0.1:${server.port}/ws`;
}, 30_000);

afterAll(async () => {
  for (const s of sockets) s.close();
  clients?.close();
  await hub?.shutdown();
  server?.stop(true);
  source?.stop();
});

/** a client that collects what it receives */
async function connect(hello: Record<string, unknown>) {
  const ws = new WebSocket(url), got: any[] = [];
  sockets.push(ws);
  ws.onmessage = e => got.push(JSON.parse(String(e.data)));
  await new Promise(r => { ws.onopen = r; });
  ws.send(JSON.stringify({ type: "hello", ...hello }));
  await waitUntil(() => got.some(m => m.type === "welcome" || m.type === "error"));
  const send = (m: Record<string, unknown>) => ws.send(JSON.stringify(m));
  const of = (type: string) => got.filter(m => m.type === type);
  return { ws, got, send, of };
}

/** a client replaying the walk at four times the speed */
async function replaying(hello: Record<string, unknown> = {}) {
  const c = await connect(hello);
  c.send({ type: "replay", recording: "walk" });
  await waitUntil(() => c.of("subscribed").length > 0);
  c.send({ type: "control", action: "speed", value: 4 });
  return c;
}

describe("object-detection clients", () => {
  it("a client replaying a session sees the walker, with the session's rig", { timeout: 30_000 }, async () => {
    const c = await replaying();
    const sub = c.of("subscribed")[0];
    expect([sub.owner, sub.sensors]).toEqual([true, ["a", "b", "c"]]);
    await waitUntil(() => c.of("objects").some(m => m.objects.some((o: WorldObject) => o.cls === "person" && o.moved)), 20);
    const m = c.of("objects").filter(x => x.objects.length).at(-1);
    expect(m.objects[0].sensors.length).toBeGreaterThan(0);
    expect(c.of("track").some(t => t.event === "start")).toBe(true);
    const p = ROOM.people(m.t - T0)[0], o = m.objects.find((x: WorldObject) => x.cls === "person");
    if (p && o) expect(Math.hypot(o.x - p.x, o.y - p.y)).toBeLessThan(0.5);
    c.ws.close();
  });

  it("options: classes and region; rate limits messages", { timeout: 30_000 }, async () => {
    const c = await replaying({ options: { classes: ["static object"], rate: 2 } });
    await Bun.sleep(3000);
    const objs = c.of("objects");
    expect(objs.length).toBeLessThanOrEqual(8);
    expect(objs.every(m => m.objects.every((o: WorldObject) => o.cls === "static object"))).toBe(true);
    c.ws.close();
  });

  it("only the owner controls a replay; others may watch it", { timeout: 30_000 }, async () => {
    const own = await replaying(), id = own.of("subscribed")[0].source, other = await connect({});
    other.send({ type: "subscribe", source: id });
    await waitUntil(() => other.of("subscribed").length > 0);
    expect(other.of("subscribed")[0].owner).toBe(false);
    other.send({ type: "control", action: "pause" });
    await waitUntil(() => other.of("error").length > 0);
    expect(other.of("error")[0].message).toMatch(/not watching a replay of its own/);
    own.send({ type: "control", action: "pause" });
    await waitUntil(() => own.of("state").some(s => s.replay.playing === false));
    own.ws.close(); other.ws.close();
  });

  it("refuses unknown clients when closed; a registered one gets its options", async () => {
    store.data.open = false;
    try {
      const stranger = await connect({ name: "x" });
      expect(stranger.of("error")[0].message).toBe("unknown client");
      const e = store.addClient({ name: "lobby", options: { classes: ["person"] } });
      const known = await connect({ token: e.token });
      expect(known.of("welcome")[0].client).toMatchObject({ name: "lobby", registered: true });
      expect(known.of("welcome")[0].options).toEqual({ classes: ["person"] });
      known.ws.close();
    } finally {
      store.data.open = true;
    }
  });

  it("a recording's tracks computed in the background; a replay then comes from the cache", { timeout: 60_000 }, async () => {
    const job = hub.processRecording("walk");
    await job.finished;
    expect([job.state().error, job.state().done, job.state().running]).toEqual(["", job.state().total, false]);
    expect(job.state().total).toBeGreaterThan(300);
    expect(readdirSync(join(cache, "walk")).filter(f => f.endsWith(".jsonl")).length).toBe(1);
    const c = await replaying();
    const id = c.of("subscribed")[0].source;
    await waitUntil(() => hub.replay(id).objects !== null);
    expect(hub.replay(id).objects).toBe("cache");
    await waitUntil(() => c.of("objects").some(m => m.objects.length > 0), 20);
    c.ws.close();
  });

  it("the committed empty database is the defaults without a name; a new server is named after its file", () => {
    const template = join(dirname(fileURLToPath(import.meta.url)), "../empty.db"), { name: _, ...unnamed } = defaults("");
    expect(new SettingsDb(template).load()).toEqual(unnamed);                  // scripts/empty-db.ts wrote it
    expect(new Store(join(dir, "hall.db"), "hall", template).data).toEqual(defaults("hall"));
    expect(new Store(join(dir, "hall.db"), "other").data.name).toBe("hall");   // stored with it
  });

  it("settings: applied at once and saved; a refused one changes nothing", async () => {
    const db = join(dir, "lobby.db"), st = new Store(db, "lobby"), moves: unknown[] = [];
    st.data.source.url = source.url;
    const h = new Hub("lobby", sourceAddress(st.data), defaultConfig(), cacheRoot(dir, st.data));
    h.start();
    const listener = { at: { host: "127.0.0.1", port: 8020 }, move(to: { host: string; port: number }) { moves.push(to); this.at = to; } };
    const a = createApp(h, st, null, null, b => applySettings(h, st, listener, dir, b));
    const put = (b: unknown) => a(new Request("http://localhost:8020/api/settings", { method: "PUT", body: JSON.stringify(b), headers: { "Content-Type": "application/json" } }));
    try {
      expect((await (await a(new Request("http://localhost:8020/api/settings"))).json() as any).values).toMatchObject({ name: "lobby", port: 8020, maxSessions: 2 });
      expect((await put({ maxSessions: 4, port: 8021, cache: "elsewhere" })).status).toBe(200);
      expect([h.maxProcessing, h.cacheRoot, moves]).toEqual([4, join(dir, "elsewhere", "lobby"), [{ host: "127.0.0.1", port: 8021 }]]);
      const live = h.live;
      expect((await put({ name: "hall" })).status).toBe(200);                   // the live processing starts afresh
      expect([h.name, h.live === live, h.cacheRoot, h.source.name]).toEqual(["hall", false, join(dir, "elsewhere", "hall"), "hall"]);
      await waitUntil(() => !!h.live?.conn.up);
      expect((await put({ name: "a b" })).status).toBe(400);
      expect((await put({ maxSessions: 0 })).status).toBe(400);
      expect(new Store(db).data).toMatchObject({ name: "hall", port: 8021, maxSessions: 4, cache: "elsewhere" });
    } finally {
      await h.shutdown();
    }
  });
});
