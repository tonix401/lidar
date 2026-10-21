// WebSocket clients (/ws): each says hello (a registered client's token, or anonymous where the store is open),
// subscribes to a source (the live sensors, or a replay session), and gets what its profile sends:
//   objects — fused world tracks per scan set, as JSON (protocol.ts), with track start/end events; its options
//             (rate, classes, region, its own coordinate frame, trails) apply on the way out;
//   debug   — every sensor's frames, binary (protocol.ts frameMessage), and their layouts.
// A client that falls behind (its send buffer is full) misses messages; nothing queues up without bound.
// Protocol: docs/api.md, "WebSocket".
import { randomBytes } from "node:crypto";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { describeError, ValueError } from "./errors";
import type { Hub } from "./hub";
import { log } from "./log";
import { forClient, frameMessage, PROTOCOL } from "./protocol";
import type { Frame, Header } from "./recording/format";
import { recordingPath } from "./recording/catalog";
import type { ReplaySession } from "./replay";
import type { ObjectsTick } from "./sensorSet";
import { checkOptions, PROFILES, type ClientOptions, type Profile, type Store } from "./store";

export const MAX_BUFFERED = { objects: 256 * 1024, debug: 8 * 1024 * 1024 };
export const SESSION_GRACE_S = 30;           // a replay session nobody watches ends after this long

export interface Conn {
  id: string; name: string; profile: Profile; options: ClientOptions; client: string | null;   // registered client id
  hello: boolean; source: string | null;     // "live" or a session id
  lastSent: number; seen: Set<number>; layouts: Map<string, Header>; sent: number; dropped: number;
}

type WS = ServerWebSocket<Conn>;

export class Clients {
  private conns = new Set<WS>();
  private timer: ReturnType<typeof setInterval>;
  readonly websocket: WebSocketHandler<Conn>;

  constructor(private hub: Hub, private store: Store | null, private recDir: string) {
    hub.events = {
      liveObjects: t => this.objects("live", t),
      liveFrame: (sensor, f) => this.frame("live", sensor, f, f.hdr, { t: f.t, rate: f.rate, scan: f.seq }),
      sessionObjects: (s, t) => this.objects(s.id, t),
      sessionFrame: (s, f) => this.frame(s.id, f.sensor, f.frame, f.hdr, { t: f.frame.t, rate: f.rate, scan: f.k, epoch: f.epoch }),
      sessionState: s => this.send(s.id, null, { type: "state", source: s.id, replay: s.player.state(), error: s.error }),
      sessionClosed: s => { this.send(s.id, null, { type: "closed", source: s.id }); for (const ws of this.on(s.id)) ws.data.source = null; },
    };
    this.websocket = {
      open: ws => { this.conns.add(ws); },
      message: (ws, m) => this.message(ws, m),
      close: ws => { this.leave(ws); this.conns.delete(ws); },
    };
    this.timer = setInterval(() => this.housekeeping(), 5000);
  }

  /** answer a /ws request (true: upgraded) */
  upgrade(req: Request, server: Server<Conn>): boolean {
    const data: Conn = { id: randomBytes(4).toString("hex"), name: "", profile: "objects", options: {}, client: null, hello: false, source: null,
                         lastSent: 0, seen: new Set(), layouts: new Map(), sent: 0, dropped: 0 };
    return server.upgrade(req, { data });
  }

  /** the connected clients (GET /api/connections) */
  list(): { id: string; name: string; profile: Profile; client: string | null; source: string | null; sent: number; dropped: number }[] {
    return [...this.conns].map(({ data: c }) => ({ id: c.id, name: c.name, profile: c.profile, client: c.client, source: c.source, sent: c.sent, dropped: c.dropped }));
  }

  close(): void { clearInterval(this.timer); for (const ws of this.conns) ws.close(1001, "server stopping"); }

  private message(ws: WS, raw: string | Buffer): void {
    let m: Record<string, unknown>;
    try { m = JSON.parse(String(raw)); } catch { return this.error(ws, "expected JSON"); }
    try {
      if (m.type === "hello") return this.hello(ws, m);
      if (!ws.data.hello) return this.error(ws, "say hello first");
      switch (m.type) {
        case "subscribe": return this.subscribe(ws, String(m.source ?? "live"));
        case "options": ws.data.options = checkOptions(m.options ?? {}); return this.reply(ws, { type: "options", options: ws.data.options });
        case "replay": {                                           // a session of its own, subscribed to at once
          if (typeof m.recording !== "string") throw new ValueError("recording: a recording name");
          const s = this.hub.createSession(recordingPath(this.recDir, m.recording));
          return this.subscribe(ws, s.id);
        }
        case "control": {
          const s = this.ownSession(ws);
          s.control(String(m.action), m.value ?? null);
          return;
        }
        default: return this.error(ws, `unknown message ${JSON.stringify(m.type)}`);
      }
    } catch (e) {
      this.error(ws, describeError(e));
    }
  }

  private hello(ws: WS, m: Record<string, unknown>): void {
    const c = ws.data, entry = typeof m.token === "string" ? this.store?.byToken(m.token) ?? null : null;
    if (entry) {
      Object.assign(c, { client: entry.id, name: entry.name, profile: entry.profile, options: entry.options });
    } else {
      if (m.token !== undefined || (this.store && !this.store.data.open)) { this.error(ws, "unknown client"); ws.close(4001, "unknown client"); return; }
      const profile = (m.profile ?? "objects") as Profile;
      if (!PROFILES.includes(profile)) throw new ValueError(`profile: one of ${PROFILES.join(", ")}`);
      Object.assign(c, { name: typeof m.name === "string" ? m.name.slice(0, 80) : "anonymous", profile, options: checkOptions(m.options ?? {}) });
    }
    c.hello = true;
    this.reply(ws, { type: "welcome", client: { id: c.client ?? c.id, name: c.name, profile: c.profile, registered: !!c.client }, options: c.options,
                     live: { sensors: this.hub.sensors() }, sessions: this.hub.sessionInfo() });
  }

  private subscribe(ws: WS, source: string): void {
    const c = ws.data;
    const session = source === "live" ? null : this.hub.session(source);
    if (session && c.profile === "objects") this.hub.setObjects(session.id, true);      // the cache, or processing (may refuse: the limit)
    this.leave(ws);
    c.source = source; c.seen.clear(); c.layouts.clear(); c.lastSent = 0;
    if (session) { session.clients++; }
    this.reply(ws, { type: "subscribed", source, sensors: this.hub.sensors(session?.id ?? null), rig: this.hub.currentRig(session?.id ?? null),
                     replay: session?.player.state() ?? null });
  }

  /** stop watching the current source; a session's processing stops with its last objects client */
  private leave(ws: WS): void {
    const src = ws.data.source;
    ws.data.source = null;
    if (!src || src === "live") return;
    const s = this.hub.sessions.get(src);
    if (!s) return;
    s.clients = Math.max(0, s.clients - 1);
    if (!s.clients) s.idleSince = performance.now();
    if (s.objects && ![...this.on(src)].some(w => w.data.profile === "objects")) this.hub.setObjects(src, false);
  }

  private ownSession(ws: WS): ReplaySession {
    if (!ws.data.source || ws.data.source === "live") throw new ValueError("not replaying");
    return this.hub.session(ws.data.source);
  }

  private *on(source: string): Generator<WS> { for (const ws of this.conns) if (ws.data.source === source) yield ws; }

  private objects(source: string, tick: ObjectsTick): void {
    const now = performance.now();
    for (const ws of this.on(source)) {
      const c = ws.data;
      if (c.profile !== "objects") continue;
      if (c.options.rate && now - c.lastSent < 1000 / c.options.rate - 5) continue;
      const objects = forClient(tick.objects, c.options), ids = new Set(objects.map(o => o.id));
      for (const o of objects) if (!c.seen.has(o.id)) this.out(ws, { type: "track", source, event: "start", id: o.id, cls: o.cls, t: tick.t });
      for (const id of c.seen) if (!ids.has(id)) this.out(ws, { type: "track", source, event: "end", id, t: tick.t });
      c.seen = ids;
      if (this.out(ws, { type: "objects", source, t: tick.t, seq: tick.seq, objects })) c.lastSent = now;
    }
  }

  private frame(source: string, sensor: string, f: Frame, hdr: Header, meta: Record<string, unknown>): void {
    let msg: Uint8Array | null = null;
    for (const ws of this.on(source)) {
      const c = ws.data;
      if (c.profile !== "debug") continue;
      if (c.layouts.get(sensor) !== hdr) { this.out(ws, { type: "layout", source, sensor, hdr }); c.layouts.set(sensor, hdr); }
      if (ws.getBufferedAmount() > MAX_BUFFERED.debug) { c.dropped++; continue; }
      msg ??= frameMessage({ source, sensor, ...meta }, f.d, f.r);
      ws.sendBinary(msg);
      c.sent++;
    }
  }

  /** a JSON message to every client on a source (null: all profiles) */
  private send(source: string, profile: Profile | null, m: Record<string, unknown>): void {
    for (const ws of this.on(source)) if (!profile || ws.data.profile === profile) this.out(ws, m);
  }

  /** a JSON message to one client, unless it is behind; true if sent */
  private out(ws: WS, m: Record<string, unknown>): boolean {
    if (ws.getBufferedAmount() > MAX_BUFFERED[ws.data.profile]) { ws.data.dropped++; return false; }
    ws.send(JSON.stringify({ v: PROTOCOL, ...m }));
    ws.data.sent++;
    return true;
  }

  private reply(ws: WS, m: Record<string, unknown>): void { ws.send(JSON.stringify({ v: PROTOCOL, ...m })); }

  private error(ws: WS, message: string): void { this.reply(ws, { type: "error", message }); }

  /** end replay sessions nobody has watched (WebSocket or HTTP) for a while */
  private housekeeping(): void {
    const now = performance.now();
    for (const s of [...this.hub.sessions.values()])
      if (!s.keep && !s.clients && now - Math.max(s.idleSince, s.lastUsed) > SESSION_GRACE_S * 1000) {
        log(`session ${s.id}: nobody watching`);
        this.hub.closeSession(s.id);
      }
  }
}
