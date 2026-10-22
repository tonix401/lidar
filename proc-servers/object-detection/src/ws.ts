// Object-detection clients (/ws, libs/wire/src/objects.ts): each says hello (a registered client's token, or anonymous
// while the server is open), subscribes to a source (the live sensors, or a replay), and gets its fused world tracks
// as JSON, with track start/end events; its options (rate, classes, region, its own coordinate frame, trails) apply
// on the way out. A replay is controlled only by the connection that started it, and ends when its last client leaves.
// A client that falls behind (its send buffer is full) misses messages; nothing queues up without bound.
import { randomBytes } from "node:crypto";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { describeError, ValueError } from "@mrs6000/server-common/errors";
import { fromAllowedOrigin } from "@mrs6000/server-common/http";
import { log } from "@mrs6000/server-common/log";
import type { ObjectsTick } from "@mrs6000/server-common/sensorSet";
import { CLIENT_PROTOCOL, forClient, type ClientOptions } from "@mrs6000/wire/objects";
import { ACTIONS, type Action } from "@mrs6000/wire/source";
import type { Hub } from "./hub";
import type { ClientReplay } from "./replay";
import { checkOptions, type Store } from "./store";

export const MAX_BUFFERED = 256 * 1024;

export interface Conn {
  id: string; name: string; options: ClientOptions; client: string | null;   // registered client id
  hello: boolean; source: string | null;     // "live" or a replay id
  owns: string | null;                       // the replay it started
  lastSent: number; seen: Set<number>; sent: number; dropped: number;
}

type WS = ServerWebSocket<Conn>;

export class Clients {
  private conns = new Set<WS>();
  readonly websocket: WebSocketHandler<Conn>;

  constructor(private hub: Hub, private store: Store) {
    hub.events = {
      objects: (source, t) => this.objects(source, t),
      state: r => this.send(r.id, { type: "state", source: r.id, replay: r.replay, error: r.error }),
      closed: (id, reason) => { for (const ws of this.on(id)) { this.out(ws, { type: "closed", source: id, reason }); ws.data.source = null; } },
    };
    this.websocket = {
      open: ws => { this.conns.add(ws); },
      message: (ws, m) => this.message(ws, m),
      close: ws => { this.leave(ws); this.conns.delete(ws); },
    };
  }

  /** answer a /ws request; a browser page from another site is refused */
  upgrade(req: Request, server: Server<Conn>): boolean | Response {
    if (!fromAllowedOrigin(req, this.store.data.origins)) return new Response("origin not allowed", { status: 403 });
    const data: Conn = { id: randomBytes(4).toString("hex"), name: "", options: {}, client: null, hello: false, source: null, owns: null,
                         lastSent: 0, seen: new Set(), sent: 0, dropped: 0 };
    return server.upgrade(req, { data });
  }

  list(): { id: string; name: string; client: string | null; source: string | null; sent: number; dropped: number }[] {
    return [...this.conns].map(({ data: c }) => ({ id: c.id, name: c.name, client: c.client, source: c.source, sent: c.sent, dropped: c.dropped }));
  }

  close(): void { for (const ws of this.conns) ws.close(1001, "server stopping"); }

  private message(ws: WS, raw: string | Buffer): void {
    let m: Record<string, unknown>;
    try { m = JSON.parse(String(raw)); } catch { return this.error(ws, "expected JSON"); }
    try {
      if (m.type === "hello") return this.hello(ws, m);
      if (!ws.data.hello) return this.error(ws, "say hello first");
      switch (m.type) {
        case "subscribe": return this.subscribe(ws, String(m.source ?? "live"));
        case "options": ws.data.options = checkOptions(m.options ?? {}); return this.reply(ws, { type: "options", options: ws.data.options });
        case "replay": {                                           // a replay of its own, subscribed to once it is ready
          if (typeof m.recording !== "string") throw new ValueError("recording: a recording name");
          const r = this.hub.createReplay(m.recording);
          ws.data.owns = r.id;
          r.ready.then(() => (this.conns.has(ws) ? this.subscribe(ws, r.id) : this.hub.closeReplay(r.id, "its client left")), e => { this.hub.closeReplay(r.id, describeError(e)); this.error(ws, describeError(e)); });
          return;
        }
        case "control": {
          const src = ws.data.source;
          if (!src || src === "live" || ws.data.owns !== src) throw new ValueError("not watching a replay of its own");
          if (!ACTIONS.includes(m.action as Action)) throw new ValueError(`action: one of ${ACTIONS.join(", ")}`);
          const v = m.value ?? null;
          if (v !== null && typeof v !== "number" && typeof v !== "boolean") throw new ValueError("value: a number, true/false or null");
          this.hub.replay(src).control(m.action as Action, v);
          return;
        }
        default: return this.error(ws, `unknown message ${JSON.stringify(m.type)}`);
      }
    } catch (e) {
      this.error(ws, describeError(e));
    }
  }

  private hello(ws: WS, m: Record<string, unknown>): void {
    const c = ws.data, entry = typeof m.token === "string" ? this.store.byToken(m.token) : null;
    if (entry) {
      Object.assign(c, { client: entry.id, name: entry.name, options: entry.options });
    } else {
      if (m.token !== undefined || !this.store.data.open) { this.error(ws, "unknown client"); ws.close(4001, "unknown client"); return; }
      Object.assign(c, { name: typeof m.name === "string" ? m.name.slice(0, 80) : "anonymous", options: checkOptions(m.options ?? {}) });
    }
    c.hello = true;
    this.reply(ws, { type: "welcome", server: this.hub.name, client: { id: c.client ?? c.id, name: c.name, registered: !!c.client }, options: c.options,
                     sensors: this.hub.live?.names ?? [] });
    log(`client ${c.name} (${c.id}) connected`);
  }

  private subscribe(ws: WS, source: string): void {
    const c = ws.data, r: ClientReplay | null = source === "live" ? null : this.hub.replay(source);
    this.leave(ws, false);
    c.source = source; c.seen.clear(); c.lastSent = 0;
    if (r) r.clients++;
    this.reply(ws, { type: "subscribed", source, sensors: r ? r.sensors : this.hub.live?.names ?? [], rig: r ? r.pipeline.rig : this.hub.liveRig(),
                     replay: r?.replay ?? null, owner: !!r && c.owns === r.id });
  }

  /** stop watching the current source */
  private leave(ws: WS, closing = true): void {
    const src = ws.data.source;
    ws.data.source = null;
    if (closing) ws.data.owns = null;
    if (!src || src === "live") return;
    const r = this.hub.replays.get(src);
    if (!r) return;
    r.clients = Math.max(0, r.clients - 1);
    if (!r.clients) this.hub.closeReplay(r.id, "nobody watching");
  }

  private *on(source: string): Generator<WS> { for (const ws of this.conns) if (ws.data.source === source) yield ws; }

  private objects(source: string, tick: ObjectsTick): void {
    const now = performance.now();
    for (const ws of this.on(source)) {
      const c = ws.data;
      if (c.options.rate && now - c.lastSent < 1000 / c.options.rate - 5) continue;
      const objects = forClient(tick.objects, c.options), ids = new Set(objects.map(o => o.id));
      for (const o of objects) if (!c.seen.has(o.id)) this.out(ws, { type: "track", source, event: "start", id: o.id, cls: o.cls, t: tick.t });
      for (const id of c.seen) if (!ids.has(id)) this.out(ws, { type: "track", source, event: "end", id, t: tick.t });
      c.seen = ids;
      if (this.out(ws, { type: "objects", source, t: tick.t, seq: tick.seq, objects })) c.lastSent = now;
    }
  }

  private send(source: string, m: Record<string, unknown>): void { for (const ws of this.on(source)) this.out(ws, m); }

  /** a JSON message to one client, unless it is behind; true if sent */
  private out(ws: WS, m: Record<string, unknown>): boolean {
    if (ws.getBufferedAmount() > MAX_BUFFERED) { ws.data.dropped++; return false; }
    ws.send(JSON.stringify({ v: CLIENT_PROTOCOL, ...m }));
    ws.data.sent++;
    return true;
  }

  private reply(ws: WS, m: Record<string, unknown>): void { ws.send(JSON.stringify({ v: CLIENT_PROTOCOL, ...m })); }

  private error(ws: WS, message: string): void { this.reply(ws, { type: "error", message }); }
}
