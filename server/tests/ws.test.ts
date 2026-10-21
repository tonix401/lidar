// WebSocket clients (src/ws.ts) on a real server: an objects client replaying a simulated three-sensor session sees
// the walker; its options apply; a debug client gets layouts and binary frames; a closed store refuses strangers.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compose, fromParams, invert, poseError, toParams } from "@mrs6000/processing/fusion/pose";
import { RIG3, ROOM } from "@mrs6000/processing/sim/rig";
import { writeSession } from "@mrs6000/processing/sim/session";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/http";
import { Hub } from "../src/hub";
import { readFrameMessage, type WorldObject } from "../src/protocol";
import { Store } from "../src/store";
import { Clients, type Conn } from "../src/ws";
import { waitUntil } from "./helpers";

const T0 = 1.7e9;
let dir = "", hub: Hub, store: Store, clients: Clients, server: ReturnType<typeof Bun.serve<Conn>>, url = "";
const sockets: WebSocket[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeSession(join(dir, "walk"), RIG3.map((s, k) => ({ ...s, B: 181, noise: 0.01, seed: k + 1 })), ROOM, 14, T0);
  store = new Store(null);
  hub = new Hub(dir, [], 3, null, null, store.processing);
  hub.cfg.objects.learn = 2;
  clients = new Clients(hub, store, dir);
  const app = createApp(hub, dir, { store });
  server = Bun.serve<Conn>({ port: 0, hostname: "127.0.0.1", websocket: clients.websocket,
                             fetch: (req, srv) => (new URL(req.url).pathname === "/ws" ? (clients.upgrade(req, srv) ? undefined : new Response("no", { status: 400 })) : app(req)) });
  url = `ws://127.0.0.1:${server.port}/ws`;
});

afterAll(async () => {
  for (const s of sockets) s.close();
  clients.close();
  await hub.shutdown();
  server.stop(true);
});

/** a client that collects what it receives */
async function connect(hello: Record<string, unknown>) {
  const ws = new WebSocket(url), got: any[] = [], frames: ReturnType<typeof readFrameMessage>[] = [];
  ws.binaryType = "arraybuffer";
  sockets.push(ws);
  ws.onmessage = e => { if (typeof e.data === "string") got.push(JSON.parse(e.data)); else frames.push(readFrameMessage(new Uint8Array(e.data))); };
  await new Promise(r => { ws.onopen = r; });
  ws.send(JSON.stringify({ type: "hello", ...hello }));
  await waitUntil(() => got.some(m => m.type === "welcome" || m.type === "error"));
  const send = (m: Record<string, unknown>) => ws.send(JSON.stringify(m));
  const of = (type: string) => got.filter(m => m.type === type);
  return { ws, got, frames, send, of };
}

/** a replay of the walk with the true poses (as if calibrated), at four times the speed */
function walkSession() {
  const s = hub.createSession(join(dir, "walk"));
  hub.setRig({ sensors: RIG3.map(r => ({ name: r.name, pose: toParams(r.pose), calibrated: "test" })) }, s.id);
  s.control("speed", 4);
  return s;
}

describe("WebSocket clients", () => {
  it("an objects client replaying a session sees the walker", { timeout: 30_000 }, async () => {
    const s = walkSession(), c = await connect({ name: "test", profile: "objects" });
    expect(c.of("welcome")[0]).toMatchObject({ v: 1, client: { name: "test", profile: "objects", registered: false } });
    c.send({ type: "subscribe", source: s.id });
    await waitUntil(() => c.of("subscribed").length === 1);
    expect(c.of("subscribed")[0].sensors).toEqual(["a", "b", "c"]);
    expect(s.processing).toBe(true);
    await waitUntil(() => c.of("objects").filter(m => m.objects.length === 1).length >= 20, 20);
    const ticks = c.of("objects").filter(m => m.objects.length === 1 && m.t - T0 > 5);
    const err = ticks.map(m => { const p = ROOM.people(m.t - T0)[0], o: WorldObject = m.objects[0]; return Math.hypot(o.x - p.x, o.y - p.y); }).sort((a, b) => a - b);
    expect(err[err.length >> 1]).toBeLessThan(0.1);
    expect(ticks.at(-1)!.objects[0]).toMatchObject({ cls: "person", sensors: ["a", "b", "c"] });
    expect(ticks.at(-1)!.objects[0].trail).toBeUndefined();                       // no trails unless asked
    expect(c.of("track").some(m => m.event === "start" && m.source === s.id)).toBe(true);
    c.ws.close();
    await waitUntil(() => s.objects === null);                                    // the last objects client left
    hub.closeSession(s.id);
  });

  it("a client's options: region, its own frame, classes, rate", { timeout: 30_000 }, async () => {
    const s = walkSession();
    const all = await connect({}), none = await connect({ options: { region: [[10, 10], [11, 10], [11, 11]] } });
    const moved = await connect({ options: { transform: { x: 1, y: 2, yaw: 90 }, trails: true } }), slow = await connect({ options: { rate: 2, classes: ["person"] } });
    for (const c of [all, none, moved, slow]) c.send({ type: "subscribe", source: s.id });
    await waitUntil(() => all.of("objects").filter(m => m.objects.length).length >= 30, 20);
    expect(none.of("objects").every(m => m.objects.length === 0)).toBe(true);     // nothing in its region
    const byT = new Map(all.of("objects").map(m => [m.seq, m.objects[0]]));
    const pairs = moved.of("objects").filter(m => m.objects.length && byT.get(m.seq)).map(m => [byT.get(m.seq), m.objects[0]] as const);
    expect(pairs.length).toBeGreaterThan(10);
    for (const [w, o] of pairs) {                                                 // client frame: origin (1, 2), x along world y
      expect(o.x).toBeCloseTo(w.y - 2, 2);
      expect(o.y).toBeCloseTo(-(w.x - 1), 2);
    }
    expect(pairs.at(-1)![1].trail.length).toBeGreaterThan(0);
    const n = all.of("objects").length, m = slow.of("objects").length;
    expect(m).toBeLessThan(n / 2);                                                // 2 per second of the 10 sets
    expect(slow.of("objects").every(x => x.objects.every((o: WorldObject) => o.cls === "person"))).toBe(true);
    for (const c of [all, none, moved, slow]) c.ws.close();
    hub.closeSession(s.id);
  });

  it("a debug client gets each sensor's layout once, then binary frames", { timeout: 30_000 }, async () => {
    const c = await connect({ profile: "debug" });
    c.send({ type: "replay", recording: "walk" });                               // a session of its own
    await waitUntil(() => c.frames.length >= 12);
    const layouts = c.of("layout");
    expect(layouts.map(l => l.sensor).sort()).toEqual(["a", "b", "c"]);
    expect(layouts[0].hdr).toMatchObject({ layers: 24, beams: 181 });
    const f = c.frames[3];
    expect(f.meta).toMatchObject({ v: 1, type: "frame" });
    expect(f.d.length).toBe(24 * 181);
    expect(f.r.length).toBe(24 * 181);
    expect(Math.max(...f.d) * 0.0125).toBeGreaterThan(2);                         // ranges of the room
    const id = c.of("subscribed")[0].source;
    expect(hub.session(id).processing).toBe(false);                               // debug clients process themselves
    c.send({ type: "control", action: "pause" });
    await waitUntil(() => c.of("state").some(m => m.replay.playing === false));
    c.ws.close();
    hub.closeSession(id);
  });

  it("refuses unknown clients when the store is closed; a registered one gets its profile", async () => {
    store.data.open = false;
    try {
      const stranger = await connect({ name: "x" });
      expect(stranger.of("error")[0].message).toBe("unknown client");
      const entry = store.addClient({ name: "wall display", profile: "debug" });
      const known = await connect({ token: entry.token, profile: "objects" });   // the profile is the registry's
      expect(known.of("welcome")[0].client).toMatchObject({ id: entry.id, name: "wall display", profile: "debug", registered: true });
      known.ws.close();
    } finally { store.data.open = true; }
  });

  it("a second objects replay of the same recording comes from the track cache", { timeout: 60_000 }, async () => {
    writeSession(join(dir, "short"), RIG3.map((s, k) => ({ ...s, B: 181, noise: 0.01, seed: k + 1 })), ROOM, 7, T0);
    const run = async () => {
      const s = hub.createSession(join(dir, "short"));
      s.control("pause");                                         // before its first frame: the run starts at 0
      hub.setRig({ sensors: RIG3.map(r => ({ name: r.name, pose: toParams(r.pose), calibrated: "test" })) }, s.id);
      s.control("loop", false); s.control("speed", 4);
      const c = await connect({});
      c.send({ type: "subscribe", source: s.id });
      await waitUntil(() => c.of("subscribed").length === 1);
      const mode = s.objects;
      s.control("play");
      await waitUntil(() => !s.player.playing && (s.player.state().index ?? 0) === (s.player.state().count ?? 0) - 1, 30);
      await Bun.sleep(300);                                       // the last sets
      c.ws.close();
      hub.closeSession(s.id);
      return { mode, ticks: c.of("objects") };
    };
    const first = await run();
    expect(first.mode).toBe("processing");
    expect(readdirSync(join(dir, "short.tracks")).filter(f => f.endsWith(".jsonl")).length).toBe(1);
    const second = await run();
    expect(second.mode).toBe("cache");                            // no workers this time
    const objs = (t: { objects: WorldObject[] }[]) => t.filter(m => m.objects.length).map(m => m.objects.map(o => [o.id, o.x, o.y]));
    expect(objs(second.ticks)).toEqual(objs(first.ticks));
    expect(objs(first.ticks).length).toBeGreaterThan(10);
    hub.cfg.objects.minPoints += 1;                               // another setting: another key, computed again
    const third = await run();
    expect(third.mode).toBe("processing");
    hub.cfg.objects.minPoints -= 1;
  });

  it("a recording's tracks computed in the background, faster than real time", { timeout: 60_000 }, async () => {
    const path = join(dir, "batch");
    writeSession(path, RIG3.map((s, k) => ({ ...s, B: 181, noise: 0.01, seed: k + 1 })), ROOM, 10, T0);
    const app = createApp(hub, dir, { store });
    const call = async (method: string, url: string, body?: unknown) =>
      (await app(new Request("http://x" + url, { method, body: body === undefined ? undefined : JSON.stringify(body) }))).json() as Promise<any>;
    // the session's rig (true poses) first: the cache key includes it
    const s0 = hub.createSession(path);
    hub.setRig({ sensors: RIG3.map(r => ({ name: r.name, pose: toParams(r.pose), calibrated: "test" })) }, s0.id);
    hub.closeSession(s0.id);
    const started = await call("POST", "/api/recordings/batch/process");
    expect([started.recording, started.running]).toEqual(["batch", true]);
    await waitUntil(async () => !(await call("GET", "/api/recordings/batch/process")).running, 40);
    const done = await call("GET", "/api/recordings/batch/process");
    expect([done.done, done.total, done.error]).toEqual([300, 300, ""]);
    console.log(`3 sensors × 10 s computed in ${done.seconds} s`);
    expect(done.seconds).toBeLessThan(10);
    const s = hub.createSession(path), c = await connect({});
    c.send({ type: "subscribe", source: s.id });
    await waitUntil(() => c.of("subscribed").length === 1);
    expect(s.objects).toBe("cache");
    await waitUntil(() => c.of("objects").some(m => m.objects.length === 1), 20);
    c.ws.close();
    hub.closeSession(s.id);
  });

  it("calibrates a replayed rig on the server: empty scene, one walk, the solve", { timeout: 90_000 }, async () => {
    const path = join(dir, "calib");
    writeSession(path, RIG3.map((s, k) => ({ ...s, B: 181, noise: 0.01, seed: k + 1 })), ROOM, 40, T0);
    const app = createApp(hub, dir, { store });
    const call = async (method: string, url: string, body?: unknown) =>
      (await app(new Request("http://x" + url, { method, body: body === undefined ? undefined : JSON.stringify(body) }))).json() as Promise<any>;
    const s = hub.createSession(path);
    s.control("pause");
    const st = await call("POST", "/api/calibration", { action: "start", session: s.id, options: { walkSeconds: 20, minSamples: 80 } });
    expect([st.target, st.phase]).toEqual([s.id, "empty"]);
    s.control("speed", 4); s.control("play");
    await waitUntil(async () => ["done", "failed"].includes((await call("GET", "/api/calibration")).phase), 60);
    const done = await call("GET", "/api/calibration");
    expect([done.phase, done.error]).toEqual(["done", ""]);
    const accepted = await call("POST", "/api/calibration", { action: "accept" });
    expect(accepted.sensors.every((e: { pose?: unknown }) => e.pose)).toBe(true);
    const meta = JSON.parse(readFileSync(join(path, "session.json"), "utf8"));
    const first = meta.truth[0].pose, world = invert(fromParams({ ...first, z: 0, pitch: 0, roll: 0 }));   // a's levelled frame
    for (const e of meta.rig.sensors) {
      const truth = compose(world, fromParams(meta.truth.find((t: { name: string }) => t.name === e.name).pose)), err = poseError(fromParams(e.pose), truth);
      console.log(`${e.name}: ${(err.dist * 100).toFixed(1)} cm, ${err.angle.toFixed(2)}°`);
      expect(err.dist).toBeLessThan(0.05);
      expect(err.angle).toBeLessThan(0.5);
    }
    expect(hub.calibration).toBeNull();
    hub.closeSession(s.id);
  });

  it("past the processing limit, a subscription is refused with a reason", async () => {
    hub.maxProcessing = 0;
    try {
      const s = hub.createSession(join(dir, "walk")), c = await connect({});
      c.send({ type: "subscribe", source: s.id });
      await waitUntil(() => c.of("error").length > 0);
      expect(c.of("error")[0].message).toMatch(/at most 0 replays with processing/);
      hub.closeSession(s.id);
      c.ws.close();
    } finally { hub.maxProcessing = 2; }
  });
});
