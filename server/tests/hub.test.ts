// The Hub: live sensors (recorded, published), replay sessions with their controls and epochs; several sensors and
// recorded sessions; the rig; and the HTTP API on top (called as a fetch handler, no network).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http";
import { Hub, LiveSensor } from "../src/hub";
import { parse, sensorSpecs } from "../src/main";
import type { Scan } from "../src/model";
import { listRecordings, recordingPath } from "../src/recording/catalog";
import { Session, SessionRecorder, SESSION_FILE } from "../src/recording/session";
import { loadRig, mergeRig, parseSensorArg, type Rig } from "../src/rig";
import { Store } from "../src/store";
import { endless, makeScan, waitUntil, writeRecording } from "./helpers";

let dir = "";
const hubs: Hub[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hub-")); });
afterEach(async () => { for (const h of hubs.splice(0)) await h.shutdown(); });

function hub(sources: (() => AsyncIterable<Scan>)[], o: { names?: string[]; ips?: string[]; rig?: Rig; rigPath?: string } = {}): Hub {
  const names = o.names ?? (sources.length === 1 ? ["sensor"] : sources.map((_, i) => String.fromCharCode(97 + i)));
  const h = new Hub(join(dir, "recs"), sources.map((s, i) => new LiveSensor(names[i], s, o.ips?.[i] ?? "")), 0.05, o.rig ?? null, o.rigPath ?? null);
  h.start();
  hubs.push(h);
  return h;
}

const POSE = { x: 1, y: -2, z: 1.1, yaw: 30, pitch: 1.5, roll: -0.5 };

/** a response whose JSON the tests read freely */
type Reply = Omit<Response, "json"> & { json(): Promise<any> };

describe("hub", () => {
  it("publishes and records live frames", async () => {
    const h = hub([endless()]);
    await waitUntil(() => h.feed().frameId >= 3);
    const { meta } = await h.feed().wait(0);
    expect([meta.source, meta.layers, typeof meta.epoch]).toEqual(["live", 3, "number"]);
    await h.startRecording();
    await waitUntil(() => (h.recorder.state().scans ?? 0) >= 3);
    await h.recorder.stop();
    expect(readdirSync(join(dir, "recs")).filter(f => f.endsWith(".tpc.zstd")).length).toBe(1);
  });

  it("retries a failing live source and reports recovery", async () => {
    let calls = 0;
    const flaky = () => { if (++calls < 3) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); return endless()(); };
    const h = hub([flaky]);
    await waitUntil(() => h.feed().frameId >= 1);
    await waitUntil(() => h.liveError() === "");
    expect(calls).toBe(3);
  });

  it("keeps the live error while failing", async () => {
    const h = hub([() => { throw Object.assign(new Error(), { code: "ETIMEDOUT" }); }]);
    await waitUntil(() => h.liveError() === "sensor: timed out");
    expect(h.state().live_error).toBe("sensor: timed out");
  });

  it("a replay session: play, pause, step, seek, speed and epochs, while live goes on", async () => {
    const h = hub([endless()]), s = h.createSession(writeRecording(join(dir, "r.tpc"), 20, { dt: 0.05 }));
    const meta = () => h.feed(null, s.id).meta, rep = () => meta().replay as { index: number; count: number; upside_down: boolean };
    await waitUntil(() => (rep()?.index ?? 0) >= 3);
    expect([meta().source, meta().session, rep().count, rep().upside_down]).toEqual(["replay", s.id, 20, true]);
    expect(h.feed().meta.source).toBe("live");                     // the live feed is untouched
    const firstEpoch = meta().epoch as number;
    s.control("pause");
    await Bun.sleep(150);
    const idx = rep().index;
    await Bun.sleep(150);
    expect(rep().index).toBe(idx);
    expect(h.state(s.id).replay.playing).toBe(false);
    s.control("step", 1);                                          // continuous: same epoch
    await waitUntil(() => rep().index === idx + 1);
    expect(meta().epoch).toBe(firstEpoch);
    s.control("step", -1);                                         // a jump back: a new epoch
    await waitUntil(() => rep().index === idx);
    expect(meta().epoch).toBeGreaterThan(firstEpoch);
    s.control("seek", 15);
    await waitUntil(() => rep().index === 15);
    s.control("speed", 3.1);
    expect(s.player.speed).toBe(4);
    s.control("toggle");
    expect(s.player.playing).toBe(true);
    expect(() => s.control("fly")).toThrow();
  });

  it("two sessions replay independently", async () => {
    const h = hub([]), p = writeRecording(join(dir, "r.tpc"), 40, { dt: 0.05 });
    const a = h.createSession(p), b = h.createSession(p);
    b.control("seek", 30); b.control("pause");
    await waitUntil(() => (h.feed(null, a.id).meta.replay as { index: number } | undefined)?.index === 5);
    expect((h.feed(null, b.id).meta.replay as { index: number }).index).toBe(30);
    expect(h.sessionInfo().map(x => x.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("a session loops or stops at the end", async () => {
    const h = hub([]), s = h.createSession(writeRecording(join(dir, "r.tpc"), 4, { dt: 0.01 }));
    s.control("loop", false);
    await waitUntil(() => !s.player.playing);
    expect((h.feed(null, s.id).meta.replay as { index: number }).index).toBe(3);
    const epoch = h.state(s.id).epoch;
    s.control("play");                                             // starts over from the beginning
    await waitUntil(() => h.state(s.id).epoch > epoch);
  });

  it("a deleted recording's session reports the error and stops", async () => {
    const p = writeRecording(join(dir, "r.tpc"), 50, { dt: 0.02 }), h = hub([]), s = h.createSession(p);
    await waitUntil(() => h.feed(null, s.id).frameId >= 2);
    rmSync(p);
    await waitUntil(() => s.error !== "");
    expect(s.error).toMatch(/r\.tpc/);
  });

  it("a replay's processing is limited", () => {
    const h = hub([]), p = writeRecording(join(dir, "r.tpc"), 5);
    h.maxProcessing = 1;
    const a = h.createSession(p), b = h.createSession(p);
    h.setObjects(a.id, true);
    expect(() => h.setObjects(b.id, true)).toThrow(/at most 1/);
    h.setObjects(a.id, false);
    h.setObjects(b.id, true);
  });
});

/** a session of phases.length sensors a, b, c... scanning at 10 Hz with the given phases */
async function writeSession(folder: string, phases = [0, 0.03, 0.07], n = 10, complete = true): Promise<SessionRecorder> {
  const names = phases.map((_, i) => String.fromCharCode(97 + i));
  const rec = new SessionRecorder(join(folder, ".."), () => ({ sensors: [{ name: "a", pose: POSE }] }));
  await rec.start(names, folder);
  for (let k = 0; k < n; k++) phases.forEach((ph, i) => rec.write(names[i], makeScan(3, 5, (l, b) => 1000 + 12.5 * (i + l + b)), 1000 + ph + 0.1 * k, i === 1));
  if (complete) await rec.stop();
  return rec;
}

describe("several sensors", () => {
  it("a session is one timeline over all sensors", async () => {
    await writeSession(join(dir, "s1"));
    const meta = JSON.parse(readFileSync(join(dir, "s1", SESSION_FILE), "utf8"));
    expect(meta.complete).toBe(true);
    expect(meta.sensors.map((s: { file: string }) => s.file)).toEqual(["a.tpc.zstd", "b.tpc.zstd", "c.tpc.zstd"]);
    expect(meta.rig.sensors[0].pose).toEqual(POSE);
    const s = new Session(join(dir, "s1"));
    try {
      expect([s.count, s.sensors]).toEqual([30, ["a", "b", "c"]]);
      const times = Array.from({ length: s.count }, (_, k) => s.time(k));
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(Array.from({ length: 6 }, (_, k) => s.frame(k).sensor)).toEqual(["a", "b", "c", "a", "b", "c"]);
      const f = s.frame(4);
      expect([f.sensor, f.hdr.sensor, f.hdr.upside_down]).toEqual(["b", "b", true]);
      expect(f.t).toBeCloseTo(1000.13, 9);
      expect(s.info().sensors).toEqual(["a", "b", "c"]);
      expect(s.info().seconds).toBeCloseTo(0.97, 9);
    } finally { s.close(); }
  });

  it("a session being recorded only grows at the end", async () => {
    const rec = await writeSession(join(dir, "s1"), [0, 0.03, 0.07], 30, false);
    for (const r of rec.recorders.values()) await r.flushed();     // the first chunk of each sensor (25 scans)
    const s = new Session(join(dir, "s1"));
    try {
      const n = s.count;                                           // chunks of 25: everything up to the last common time
      expect(n).toBe(25 + 24 + 24);
      expect(Math.max(...Array.from({ length: n }, (_, k) => s.time(k)))).toBeLessThanOrEqual(Math.min(...s.recs.map(r => r.time(24))));
      await rec.stop();
      expect(s.count).toBe(90);
    } finally { s.close(); }
  });

  it("lists sessions and resolves their names", async () => {
    await writeSession(join(dir, "rec_1"));
    mkdirSync(join(dir, "not_a_session"));
    expect(listRecordings(dir).map(r => r.name)).toEqual(["rec_1"]);
    expect(recordingPath(dir, "rec_1")).toBe(join(dir, "rec_1"));
    for (const bad of ["not_a_session", "../x", "rec.1"]) expect(() => recordingPath(dir, bad)).toThrow();
  });

  it("rig merge and sensor arguments", () => {
    const rig = mergeRig({ sensors: [{ name: "a", ip: "10.0.0.1" }] }, { sensors: [{ name: "a", pose: POSE, ip: "x" }, { name: "b", time_offset_s: 0.01 }] });
    expect(rig.sensors).toEqual([{ name: "a", ip: "10.0.0.1", pose: POSE }, { name: "b", time_offset_s: 0.01 }]);
    for (const bad of [{ sensors: [{ name: "a b" }] }, { sensors: [{ name: "a", pose: { x: 1 } }] }, { sensors: 3 }]) expect(() => mergeRig(rig, bad)).toThrow();
    expect(parseSensorArg("left=192.168.0.2").name).toBe("left");
    writeFileSync(join(dir, "rig.json"), JSON.stringify({ sensors: [{ name: "a", ip: "1.2.3.4" }, { name: "b" }] }));
    const loaded = loadRig(join(dir, "rig.json"));
    expect(sensorSpecs(parse([]), loaded).map(s => s.name)).toEqual(["a"]);                  // the rig's (with an ip)
    expect(sensorSpecs(parse(["--ip", "9.9.9.9"]), loaded).map(s => s.ip)).toEqual(["9.9.9.9"]);
    expect(sensorSpecs(parse(["--sensor", "x=1", "--sensor", "y=2"]), loaded).map(s => s.name)).toEqual(["x", "y"]);
    expect(() => sensorSpecs(parse(["--sensor", "x=1", "--sensor", "x=2"]), loaded)).toThrow();
  });

  it("the store takes over an old rig.json once", () => {
    writeFileSync(join(dir, "rig.json"), JSON.stringify({ sensors: [{ name: "a", ip: "1.2.3.4", pose: POSE }] }));
    const s = new Store(join(dir, "server.json"), join(dir, "rig.json"));
    expect(s.rig.sensors).toEqual([{ name: "a", ip: "1.2.3.4", pose: POSE }]);
    expect(JSON.parse(readFileSync(join(dir, "server.json"), "utf8")).sensors[0].name).toBe("a");
    writeFileSync(join(dir, "rig.json"), JSON.stringify({ sensors: [] }));
    expect(new Store(join(dir, "server.json"), join(dir, "rig.json")).rig.sensors.length).toBe(1);   // server.json wins now
  });

  it("live errors name the sensor", async () => {
    const h = hub([endless(), () => { throw Object.assign(new Error(), { code: "ETIMEDOUT" }); }]);
    await waitUntil(() => h.liveError() === "sensor b: timed out");
  });
});

describe("HTTP API", () => {
  /** the app with two live sensors a, b, or one ("sensor") and a recording walk.tpc */
  function app(two: boolean, store: Store | null = null) {
    const recDir = join(dir, "recs");
    mkdirSync(recDir, { recursive: true });
    const h = two ? hub([endless(), endless()], { ips: ["10.0.0.1", "10.0.0.2"], rig: { sensors: [{ name: "a", ip: "10.0.0.1" }] }, rigPath: join(dir, "rig.json") })
                  : (writeRecording(join(recDir, "walk.tpc"), 30, { dt: 0.05 }), hub([endless()]));
    const front = join(dir, "dist");
    mkdirSync(front, { recursive: true });
    writeFileSync(join(front, "index.html"), "<h1>frontend</h1>");
    const handler = createApp(h, recDir, { frontendDir: front, store });
    const call = (path: string, init?: RequestInit & { json?: unknown }) =>
      handler(new Request("http://x" + path, { ...init, body: init?.json === undefined ? init?.body : JSON.stringify(init.json),
                                                headers: { ...(init?.json === undefined ? {} : { "Content-Type": "application/json" }), ...(init?.headers as Record<string, string> ?? {}) } })) as Promise<Reply>;
    return { h, call, recDir };
  }
  const post = (json: unknown) => ({ method: "POST", json });

  it("frame long-poll", async () => {
    const { call } = app(false);
    const r = await call("/api/frame?after=0");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    const meta = JSON.parse(r.headers.get("x-meta")!);
    expect([meta.layers, meta.source, (await r.arrayBuffer()).byteLength]).toEqual([3, "live", 4 * 3 * 15]);
    const r2 = await call(`/api/frame?after=${meta.id}`);
    expect(JSON.parse(r2.headers.get("x-meta")!).id).toBeGreaterThan(meta.id);
  });

  it("state, status and the frontend", async () => {
    const { call } = app(false);
    const st = await (await call("/api/state")).json();
    expect([st.source, st.session, st.recording.active, st.sensor]).toEqual(["live", null, false, true]);
    expect(await (await call("/api/status")).json()).toEqual({ device: {}, error: "" });
    expect(await (await call("/")).text()).toContain("frontend");
    expect((await call("/../../etc/passwd")).status).toBe(404);
  });

  it("recordings: list, download, delete", async () => {
    const { call, recDir } = app(false);
    const lst = await (await call("/api/recordings")).json();
    expect([lst.map((r: { name: string }) => r.name), lst[0].scans]).toEqual([["walk.tpc"], 30]);
    const dl = await call("/api/recordings/walk.tpc");
    expect(dl.status).toBe(200);
    expect((await dl.arrayBuffer()).byteLength).toBe(readFileSync(join(recDir, "walk.tpc")).length);
    expect((await call("/api/recordings/nope.tpc")).status).toBe(404);
    expect([400, 404]).toContain((await call("/api/recordings/..%2Fx.tpc")).status);
    expect(await (await call("/api/recordings/walk.tpc", { method: "DELETE" })).json()).toEqual([]);
  });

  it("record start and stop", async () => {
    const { h, call } = app(false);
    expect((await (await call("/api/record", post({ action: "start" }))).json()).recording.active).toBe(true);
    await waitUntil(() => (h.recorder.state().scans ?? 0) >= 2);
    expect((await call(`/api/recordings/${h.recorder.state().file}`, { method: "DELETE" })).status).toBe(400);   // still recording
    expect((await (await call("/api/record", post({ action: "stop" }))).json()).recording.active).toBe(false);
    expect((await call("/api/record", post({ action: "pause" }))).status).toBe(422);
  });

  it("a replay session over HTTP: its own frames, state and controls", async () => {
    const { call } = app(false);
    const s = await (await call("/api/sessions", post({ recording: "walk.tpc" }))).json();
    expect([s.recording, s.sensors]).toEqual(["walk.tpc", ["sensor"]]);
    expect((await (await call(`/api/state?session=${s.id}`)).json()).source).toBe("replay");
    await call(`/api/sessions/${s.id}/control`, post({ action: "seek", value: 20 }));
    await waitUntil(async () => (JSON.parse((await call(`/api/frame?session=${s.id}`)).headers.get("x-meta")!).replay?.index ?? 0) >= 20);
    expect((await call(`/api/sessions/${s.id}/control`, post({ action: "fly" }))).status).toBe(422);
    expect((await call("/api/sessions", post({ recording: "missing.tpc" }))).status).toBe(404);
    expect((await (await call("/api/frame")).headers.get("x-meta"))).toContain('"live"');        // live is unaffected
    expect(await (await call(`/api/sessions/${s.id}`, { method: "DELETE" })).json()).toEqual([]);
    expect((await call(`/api/state?session=${s.id}`)).status).toBe(404);
  });

  it("deleting a recording ends its sessions", async () => {
    const { h, call } = app(false);
    const s = await (await call("/api/sessions", post({ recording: "walk.tpc" }))).json();
    await call("/api/recordings/walk.tpc", { method: "DELETE" });
    expect(h.sessions.has(s.id)).toBe(false);
  });

  it("unexpected errors are short 500s", async () => {
    const { h, call } = app(false);
    h.state = () => { throw new TypeError("boom"); };
    const r = await call("/api/state");
    expect([r.status, await r.json()]).toEqual([500, { error: "TypeError: boom" }]);
  });

  it("an offline hub refuses to record", async () => {
    const h = new Hub(dir);
    const r = await createApp(h, dir)(new Request("http://x/api/record", { method: "POST", body: JSON.stringify({ action: "start" }) })) as Reply;
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("offline");
    expect(await (await createApp(h, dir)(new Request("http://x/"))).text()).toContain("Frontend not built");
  });

  it("each live sensor has its own feed", async () => {
    const { h, call } = app(true);
    await waitUntil(() => h.feed("a").frameId >= 2 && h.feed("b").frameId >= 2);
    for (const name of ["a", "b"]) {
      const meta = JSON.parse((await call(`/api/frame?sensor=${name}`)).headers.get("x-meta")!);
      expect([meta.sensor, meta.source]).toEqual([name, "live"]);
    }
    expect(JSON.parse((await call("/api/frame")).headers.get("x-meta")!).sensor).toBe("a");   // default: the first
    expect((await call("/api/frame?sensor=zz")).status).toBe(404);
    const info = await (await call("/api/sensors")).json();
    expect(info.map((s: { name: string; ip: string; live: boolean }) => [s.name, s.ip, s.live])).toEqual([["a", "10.0.0.1", true], ["b", "10.0.0.2", true]]);
    expect((await (await call("/api/state")).json()).sensors).toEqual(["a", "b"]);
  });

  it("records and replays a session; calibrating a replay stores the poses in the session", async () => {
    const { h, call, recDir } = app(true);
    const st = await (await call("/api/record", post({ action: "start" }))).json();
    expect([st.recording.active, st.recording.sensors]).toEqual([true, ["a", "b"]]);
    await waitUntil(() => [...h.recorder.recorders.values()].every(r => r.scans >= 30));
    const name = h.recorder.path!.split("/").pop()!;
    await call("/api/record", post({ action: "stop" }));
    const lst = await (await call("/api/recordings")).json();
    expect([lst[0].name, lst[0].sensors]).toEqual([name, ["a", "b"]]);
    expect(lst[0].scans).toBeGreaterThanOrEqual(60);

    const zip = new Uint8Array(await (await call(`/api/recordings/${name}`)).arrayBuffer());
    const unzipped = join(dir, "unzip");
    mkdirSync(unzipped);
    writeFileSync(join(unzipped, "s.zip"), zip);
    const listing = Bun.spawnSync(["unzip", "-l", join(unzipped, "s.zip")]).stdout.toString();
    for (const f of ["a.tpc.zstd", "b.tpc.zstd", SESSION_FILE]) expect(listing).toContain(`${name}/${f}`);
    expect(Bun.spawnSync(["unzip", "-tq", join(unzipped, "s.zip")]).exitCode).toBe(0);        // a valid archive

    const s = await (await call("/api/sessions", post({ recording: name }))).json();
    await waitUntil(() => h.feed("a", s.id).meta.source === "replay" && h.feed("b", s.id).meta.source === "replay");
    expect(await (await call(`/api/sensors?session=${s.id}`)).json()).toEqual([{ name: "a", live: false }, { name: "b", live: false }]);
    const r = await call(`/api/rig?session=${s.id}`, { method: "PUT", json: { sensors: [{ name: "b", pose: POSE }] } });
    expect(r.status).toBe(200);
    expect((await r.json()).sensors[1].pose).toEqual(POSE);
    expect(JSON.parse(readFileSync(join(recDir, name, SESSION_FILE), "utf8")).rig.sensors.at(-1).pose).toEqual(POSE);
    expect(existsSync(join(dir, "rig.json"))).toBe(false);
    expect((await call(`/api/rig?session=${s.id}`, { method: "PUT", json: { sensors: [{ name: "zz", pose: POSE }] } })).status).toBe(400);
    await call(`/api/recordings/${name}`, { method: "DELETE" });
    expect(existsSync(join(recDir, name))).toBe(false);
    expect(h.sessions.size).toBe(0);
  });

  it("the live rig is saved", async () => {
    const { call } = app(true);
    expect(await (await call("/api/rig")).json()).toEqual({ sensors: [{ name: "a", ip: "10.0.0.1" }, { name: "b" }] });
    await call("/api/rig", { method: "PUT", json: { sensors: [{ name: "a", pose: POSE, time_offset_s: 0.002 }] } });
    expect(JSON.parse(readFileSync(join(dir, "rig.json"), "utf8")).sensors).toEqual([{ name: "a", ip: "10.0.0.1", pose: POSE, time_offset_s: 0.002 }]);
    expect((await call("/api/rig", { method: "PUT", json: { sensors: [{ name: "a", pose: { x: "far" } }] } })).status).toBe(400);
  });

  it("registry, clients and settings; the admin token guards changes", async () => {
    const store = new Store(join(dir, "server.json")), { h, call } = app(false, store);
    let registry = 0;
    const c = await (await call("/api/clients", post({ name: "lobby", profile: "objects", options: { classes: ["person"], rate: 5 } }))).json();
    expect([c.name, c.profile, c.options, typeof c.token, c.token.length > 16]).toEqual(["lobby", "objects", { classes: ["person"], rate: 5 }, "string", true]);
    expect((await call("/api/clients", post({ name: "x", options: { rate: 100 } }))).status).toBe(400);
    expect((await call(`/api/clients/${c.id}`, { method: "PUT", json: { options: { trails: true } } })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, "server.json"), "utf8")).clients[0].options).toEqual({ trails: true });
    const cfg = await (await call("/api/config", { method: "PUT", json: { planes: { wb: 6 } } })).json();
    expect([cfg.planes.wb, h.cfg.planes.wb, store.processing.planes.wb]).toEqual([6, 6, 6]);
    void registry;
    store.data.adminToken = "s3cret";
    expect((await call("/api/config", { method: "PUT", json: { planes: { wb: 5 } } })).status).toBe(401);
    expect((await call("/api/config", { method: "PUT", json: { planes: { wb: 5 } }, headers: { Authorization: "Bearer s3cret" } })).status).toBe(200);
    expect((await call("/api/clients")).status).toBe(401);
    expect((await call(`/api/clients/${c.id}`, { method: "DELETE", headers: { Authorization: "Bearer s3cret" } })).status).toBe(200);
    expect(store.data.clients).toEqual([]);
  });
});
