// The source server on a real port: live sensors (recorded, sent to consumers), replays in both modes with their
// ownership rules, the rig, the HTTP API with its guards, and calibrating a recorded rig.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compose, fromParams, invert, poseError } from "@mrs6000/processing/fusion/pose";
import { RIG3, ROOM } from "@mrs6000/processing/sim/rig";
import { writeSession } from "@mrs6000/processing/sim/session";
import { defaultConfig } from "@mrs6000/processing/config/config";
import { ValueError } from "@mrs6000/server-common/errors";
import { SourcePipeline } from "@mrs6000/server-common/pipeline";
import type { ObjectsTick } from "@mrs6000/server-common/sensorSet";
import { SourceConnection, type SourceEvents, type SourceFrame, type Watch } from "@mrs6000/server-common/sourceClient";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http";
import { Hub } from "../src/hub";
import { LiveSensor } from "../src/live";
import { parse, sensorSpecs } from "../src/main";
import { applySettings } from "../src/settings";
import type { Scan } from "../src/model";
import { mergeRig, parseSensorArg } from "../src/rig";
import { Store } from "../src/store";
import { Consumers, type Conn } from "../src/ws";
import { endless, waitUntil, writeRecording } from "./helpers";

const POSE = { x: 1, y: -2, z: 1.1, yaw: 30, pitch: 1.5, roll: -0.5 };

interface Running { hub: Hub; store: Store; consumers: Consumers; app: ReturnType<typeof createApp>; base: string; stop(): Promise<void> }

let dir = "";
const running: Running[] = [], conns: SourceConnection[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "source-")); });
afterEach(async () => {
  for (const c of conns.splice(0)) c.close();
  for (const r of running.splice(0)) await r.stop();
});

/** a source server on a free port with these live sources */
function start(sources: (() => AsyncIterable<Scan>)[] = [], store = new Store(null)): Running {
  const names = sources.length === 1 ? ["sensor"] : sources.map((_, i) => String.fromCharCode(97 + i));
  const hub = new Hub(dir, store), consumers = new Consumers(hub, store), app = createApp(hub, store, { consumers });
  const server = Bun.serve<Conn>({
    port: 0, hostname: "127.0.0.1", websocket: consumers.websocket,
    fetch: (req, srv) => {
      if (new URL(req.url).pathname !== "/ws") return app(req);
      const up = consumers.upgrade(req, srv);
      return up === true ? undefined : up === false ? new Response("no", { status: 400 }) : up;
    },
  });
  hub.setLive(sources.map((s, i) => new LiveSensor(names[i], s, "", 0.05)));
  const r: Running = { hub, store, consumers, app, base: `http://127.0.0.1:${server.port}`,
                       stop: async () => { consumers.close(); await hub.shutdown(); server.stop(true); } };
  running.push(r);
  return r;
}

/** a processing server's view: everything a connection reports */
function watch(r: Running, w: Watch, token?: string) {
  const got = { frames: [] as SourceFrame[], rigs: [] as unknown[], states: [] as unknown[], ends: 0, closed: [] as string[], errors: [] as string[],
                subscribed: null as null | { source: string; count?: number; owner?: string; controls?: boolean } };
  const events: SourceEvents = {
    subscribed: s => { got.subscribed = s; }, frame: f => got.frames.push(f), rig: rig => got.rigs.push(rig), state: s => got.states.push(s),
    end: () => got.ends++, closed: reason => got.closed.push(reason), error: e => got.errors.push(e),
  };
  const c = new SourceConnection({ url: r.base, name: "test", token }, w, events, 50);
  conns.push(c);
  return { c, got };
}

const post = (json: unknown, headers: Record<string, string> = {}) =>
  ({ method: "POST", body: JSON.stringify(json), headers: { "Content-Type": "application/json", ...headers } });

describe("live sensors", () => {
  it("are recorded and sent to every live consumer: the rig, then frames with their layout", async () => {
    const r = start([endless()]), { got } = watch(r, { kind: "live" });
    await waitUntil(() => got.frames.length >= 3);
    expect(got.rigs).toEqual([{ sensors: [{ name: "sensor" }] }]);
    const f = got.frames[2];
    expect([f.sensor, f.hdr.layers, f.hdr.beams, f.d.length, f.seq]).toEqual(["sensor", 3, 5, 15, f.seq]);
    expect(got.frames.map(x => x.seq)).toEqual([...got.frames.keys()].map(k => got.frames[0].seq + k));
    await r.hub.startRecording();
    await waitUntil(() => (r.hub.recorder.state().scans ?? 0) >= 3);
    await r.hub.stopRecording();
    expect(readdirSync(dir).filter(n => n.endsWith(".tpc.zstd")).length).toBe(1);
    expect(r.consumers.list()).toMatchObject([{ name: "test", source: "live", registered: false }]);
  });

  it("when they change, live consumers subscribe afresh, and a processing pipeline follows without errors", async () => {
    const r = start([endless()]), { got } = watch(r, { kind: "live" });
    const errors: string[] = [], ticks: ObjectsTick[] = [];
    const p = new SourcePipeline({ url: r.base, name: "objects" }, { kind: "live" }, defaultConfig(),
                                 { objects: t => ticks.push(t), error: e => errors.push(e) }, { threaded: false });
    try {
      await waitUntil(() => got.frames.length >= 2 && p.names.length === 1);
      r.hub.setLive(["a", "b"].map(n => new LiveSensor(n, endless(), "", 0.05)));   // as after adding sensors to the registry
      await waitUntil(() => got.frames.some(f => f.sensor === "a") && got.frames.some(f => f.sensor === "b"));
      expect(got.subscribed).toMatchObject({ source: "live", sensors: ["a", "b"] });
      await waitUntil(() => p.names.join() === "a,b" && ticks.some(t => t.sensors.length > 0 && ticks.at(-1)!.seq > 0));
      const n = ticks.length;
      await waitUntil(() => ticks.length > n + 5);                               // keeps processing
      expect(p.set!.runners.length).toBe(2);
      expect(errors).toEqual([]);
      expect(r.consumers.list().filter(c => c.source === "live").map(c => c.name).sort()).toEqual(["objects", "test"]);
    } finally {
      p.close();
    }
  });

  it("retry a failing connection and report it under the sensor's name", async () => {
    let calls = 0;
    const flaky = () => { if (++calls < 3) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); return endless()(); };
    const r = start([endless(), flaky]);
    await waitUntil(() => r.hub.live[1].error === "sensor b: connection refused");
    await waitUntil(() => r.hub.live[1].rate > 0 && r.hub.live[1].error === "");
    expect(calls).toBe(3);
  });
});

describe("replays", () => {
  it("pull mode: every frame once, in order, as credit allows, then end", async () => {
    writeRecording(join(dir, "a.tpc"), 40);
    const r = start(), { c, got } = watch(r, { kind: "replay", recording: "a.tpc", mode: "pull" });
    await waitUntil(() => got.subscribed !== null);
    expect(got.subscribed!.count).toBe(40);
    await Bun.sleep(50);
    expect(got.frames.length).toBe(0);                                       // nothing without credit
    c.credit(15);
    await waitUntil(() => got.frames.length === 15);
    await Bun.sleep(50);
    expect(got.frames.length).toBe(15);
    c.credit(100);
    await waitUntil(() => got.ends === 1);
    expect(got.frames.map(f => f.seq)).toEqual([...Array(40).keys()]);
    expect(got.frames[39].t).toBeCloseTo(1000 + 39 * 0.1, 9);
  });

  it("stream mode: its owner controls it, others watch it by its id, and it ends with its owner", async () => {
    writeRecording(join(dir, "a.tpc"), 30);
    const r = start(), own = watch(r, { kind: "replay", recording: "a.tpc", mode: "stream" });
    await waitUntil(() => own.got.frames.length >= 3);
    const { source } = own.got.subscribed!;
    expect(r.hub.state().replays).toMatchObject([{ id: source, recording: "a.tpc", mode: "stream", owner: "test" }]);
    const joined = watch(r, { kind: "join", source });
    await waitUntil(() => joined.got.frames.length >= 2);
    expect(joined.got.subscribed).toMatchObject({ source, recording: "a.tpc", owner: "test", controls: false });
    joined.c.control("pause");
    await waitUntil(() => joined.got.errors.length > 0);
    expect(joined.got.errors[0]).toBe("only test controls this replay");
    own.c.control("pause");
    await Bun.sleep(100);
    const epoch = own.got.frames.at(-1)!.epoch, n = own.got.frames.length, m = joined.got.frames.length;
    own.c.control("seek", 2);
    await waitUntil(() => own.got.frames.length > n && joined.got.frames.length > m);
    expect([own.got.frames.at(-1)!.seq, own.got.frames.at(-1)!.epoch]).toEqual([2, epoch + 1]);
    expect([joined.got.frames.at(-1)!.seq, joined.got.frames.at(-1)!.epoch]).toEqual([2, epoch + 1]);   // the same timeline
    own.c.close();
    await waitUntil(() => joined.got.closed.length > 0);
    expect(joined.got.closed[0]).toBe("its consumer left");
    expect(r.hub.replays.size).toBe(0);
  });

  it("a pull replay cannot be watched by another consumer", async () => {
    writeRecording(join(dir, "a.tpc"), 10);
    const r = start(), own = watch(r, { kind: "replay", recording: "a.tpc", mode: "pull" });
    await waitUntil(() => own.got.subscribed !== null);
    const other = watch(r, { kind: "join", source: own.got.subscribed!.source });
    await waitUntil(() => other.got.errors.length > 0);
    expect(other.got.errors[0]).toMatch(/only a stream replay can be watched/);
  });

  it("a deleted recording ends its replays", async () => {
    writeRecording(join(dir, "a.tpc"), 30);
    const r = start(), { got } = watch(r, { kind: "replay", recording: "a.tpc", mode: "stream" });
    await waitUntil(() => got.frames.length > 0);
    expect((await r.app(new Request(r.base + "/api/recordings/a.tpc", { method: "DELETE" }))).status).toBe(200);
    await waitUntil(() => got.closed.length > 0);
    expect(got.closed[0]).toBe("recording deleted");
  });
});

describe("HTTP API", () => {
  it("recordings: list, download; record start and stop; an offline source refuses to record", async () => {
    writeRecording(join(dir, "a.tpc"), 5);
    const off = start();
    expect(((await (await off.app(new Request(off.base + "/api/recordings"))).json()) as any[])[0]).toMatchObject({ name: "a.tpc", scans: 5 });
    expect((await off.app(new Request(off.base + "/api/recordings/a.tpc"))).headers.get("content-disposition")).toMatch(/a\.tpc/);
    expect((await off.app(new Request(off.base + "/api/recordings/..%2Fx.tpc"))).status).toBeGreaterThanOrEqual(400);
    expect((await off.app(new Request(off.base + "/api/record", post({ action: "start" })))).status).toBe(400);
    const on = start([endless()]);
    expect((await on.app(new Request(on.base + "/api/record", post({ action: "start" })))).status).toBe(200);
    await waitUntil(() => (on.hub.recorder.state().scans ?? 0) >= 2);
    const st = await (await on.app(new Request(on.base + "/api/record", post({ action: "stop" })))).json() as any;
    expect(st.recording.active).toBe(false);
  });

  it("refuses other web pages and form posts; the admin token guards changes", async () => {
    const r = start([], new Store(join(dir, "source.db")));
    const add = (h: Record<string, string> = {}) => r.app(new Request(r.base + "/api/registry/sensors", post({ name: "a", ip: "10.0.0.1" }, h)));
    expect((await add({ Origin: "http://evil.example" })).status).toBe(403);
    expect((await r.app(new Request(r.base + "/api/registry/sensors", { method: "POST", body: "name=a", headers: { "Content-Type": "application/x-www-form-urlencoded" } }))).status).toBe(422);
    expect((await add({ Origin: r.base })).status).toBe(200);                 // its own page
    const ws = await fetch(r.base + "/ws", { headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", Origin: "http://evil.example" } });
    expect(ws.status).toBe(403);
    r.store.data.adminToken = "s3cret";
    expect((await r.app(new Request(r.base + "/api/registry/sensors/a", { method: "DELETE" }))).status).toBe(401);
    expect((await r.app(new Request(r.base + "/api/registry/consumers"))).status).toBe(401);
    const c = await (await r.app(new Request(r.base + "/api/registry/consumers", post({ name: "lobby" }, { Authorization: "Bearer s3cret" })))).json() as any;
    expect(new Store(join(dir, "source.db")).data.consumers[0].name).toBe("lobby");
    r.store.data.open = false;
    const stranger = watch(r, { kind: "live" });
    await waitUntil(() => stranger.got.errors.length > 0);
    expect(stranger.got.errors[0]).toBe("unknown consumer");
    const known = watch(r, { kind: "live" }, c.token);
    await waitUntil(() => known.got.subscribed !== null);
    expect(r.consumers.list().find(x => x.registered)?.name).toBe("lobby");
  });

  it("the rig: merge rules, PUT for the live rig and for a session, pushed to its consumers", async () => {
    const rig = mergeRig({ sensors: [{ name: "a", ip: "10.0.0.1" }] }, { sensors: [{ name: "a", pose: POSE, ip: "x" }, { name: "b", time_offset_s: 0.01 }] });
    expect(rig.sensors).toEqual([{ name: "a", ip: "10.0.0.1", pose: POSE }, { name: "b", time_offset_s: 0.01 }]);
    for (const bad of [{ sensors: [{ name: "a b" }] }, { sensors: [{ name: "a", pose: { x: 1 } }] }, { sensors: 3 }]) expect(() => mergeRig(rig, bad)).toThrow();
    const r = start([endless()], new Store(join(dir, "source.db")));
    r.store.addSensor({ name: "sensor" });
    const { got } = watch(r, { kind: "live" });
    await waitUntil(() => got.rigs.length === 1);
    const put = await r.app(new Request(r.base + "/api/rig", { ...post({ sensors: [{ name: "sensor", pose: POSE }] }), method: "PUT" }));
    expect(put.status).toBe(200);
    await waitUntil(() => got.rigs.length === 2);
    expect(got.rigs[1]).toEqual({ sensors: [{ name: "sensor", pose: POSE }] });
    expect(new Store(join(dir, "source.db")).data.sensors[0].pose).toEqual(POSE);
    const bad = await r.app(new Request(r.base + "/api/rig", { ...post({ sensors: [{ name: "x", pose: POSE }] }), method: "PUT" }));
    expect(bad.status).toBe(400);
  });

  it("the sensors: the registry's, else one at the default; an older source.json or rig.json taken over once", () => {
    expect(parseSensorArg("left=192.168.0.2").name).toBe("left");
    expect(sensorSpecs([{ name: "a", ip: "1.2.3.4" }, { name: "b" }, { name: "c", ip: "5.6.7.8", enabled: false }]).map(s => s.name)).toEqual(["a"]);
    expect(sensorSpecs([]).map(s => s.name)).toEqual(["sensor"]);
    expect(parse([])).toMatchObject({ offline: false });
    expect(() => parse(["--port", "8100"])).toThrow();                          // a setting, not an option
    writeFileSync(join(dir, "rig.json"), JSON.stringify({ sensors: [{ name: "a", ip: "1.2.3.4", pose: POSE }] }));
    const s = new Store(join(dir, "source.db"), [join(dir, "source.json"), join(dir, "rig.json")]);
    expect(s.rig.sensors).toEqual([{ name: "a", ip: "1.2.3.4", pose: POSE }]);
    expect(s.data.port).toBe(8000);
    writeFileSync(join(dir, "rig.json"), JSON.stringify({ sensors: [] }));
    expect(new Store(join(dir, "source.db"), [join(dir, "rig.json")]).rig.sensors.length).toBe(1);   // the database wins now
  });

  it("settings: through the page's API, applied at once, saved; a refused change changes nothing", async () => {
    const store = new Store(join(dir, "source.db")), hub = new Hub(dir, store), moves: unknown[] = [];
    const listener = { at: { host: "127.0.0.1", port: 8000 }, move(to: { host: string; port: number }) {
      if (to.port === 1) throw new ValueError("cannot listen on 127.0.0.1:1");
      moves.push(to); this.at = to;
    } };
    const app = createApp(hub, store, { onSettings: b => applySettings(hub, store, listener, dir, b) });
    const put = (b: unknown, h: Record<string, string> = {}) => app(new Request("http://x/api/settings", { ...post(b, h), method: "PUT" }));
    const got = await (await app(new Request("http://x/api/settings"))).json() as any;
    expect(got.values).toMatchObject({ host: "127.0.0.1", port: 8000, recordings: "recordings", open: true });
    expect(got.fields.map((f: { key: string }) => f.key)).toContain("adminToken");
    const ok = await (await put({ port: 8100, recordings: "elsewhere", origins: "http://localhost:5174" })).json() as any;
    expect([ok.moved, hub.recDir, store.data.origins]).toEqual([{ host: "127.0.0.1", port: 8100 }, join(dir, "elsewhere"), ["http://localhost:5174"]]);
    expect(new Store(join(dir, "source.db")).data).toMatchObject({ port: 8100, recordings: "elsewhere" });
    expect((await put({ port: 1, recordings: "third" })).status).toBe(400);    // cannot bind: nothing changed
    expect([store.data.port, hub.recDir]).toEqual([8100, join(dir, "elsewhere")]);
    expect((await put({ nope: 1 })).status).toBe(400);
    expect((await put({ open: "no" })).status).toBe(400);
    expect(await (await put({ open: false })).json()).not.toHaveProperty("moved");
    await put({ adminToken: "s3cret" });
    expect((await app(new Request("http://x/api/settings"))).status).toBe(401);
    expect((await put({ open: true })).status).toBe(401);
    expect((await put({ open: true }, { Authorization: "Bearer s3cret" })).status).toBe(200);
    expect(moves).toHaveLength(1);
  });
});

describe("calibration", () => {
  it("on a recorded rig: empty scene, one walk, the solve; accepting stores the poses in the session", { timeout: 120_000 }, async () => {
    const path = join(dir, "calib"), T0 = 1.7e9;
    writeSession(path, RIG3.map((s, k) => ({ ...s, B: 181, noise: 0.01, seed: k + 1 })), ROOM, 40, T0);
    const r = start(), call = async (method: string, url: string, body?: unknown) =>
      (await r.app(new Request(r.base + url, body === undefined ? { method } : { ...post(body), method }))).json() as Promise<any>;
    const st = await call("POST", "/api/calibration", { action: "start", recording: "calib", options: { walkSeconds: 20, minSamples: 80 } });
    expect([st.target, st.phase]).toEqual(["calib", "empty"]);
    await waitUntil(async () => ["done", "failed"].includes((await call("GET", "/api/calibration")).phase), 100);
    const done = await call("GET", "/api/calibration");
    expect([done.phase, done.error]).toEqual(["done", ""]);
    const pts = await call("GET", "/api/calibration/points");
    expect(pts.sensors.map((s: { name: string }) => s.name)).toEqual(["a", "b", "c"]);
    expect(pts.sensors.every((s: { xy: number[] }) => s.xy.length > 100)).toBe(true);
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
    expect(r.hub.calibration).toBeNull();
  });
});
