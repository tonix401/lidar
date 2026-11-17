// The processing servers' connections (/ws, the source protocol: libs/wire/src/source.ts). Each says hello (a
// registered consumer's token, or anonymous while the registry is open) and watches one source: the live sensors, a
// replay of its own (which it controls, and which ends when it disconnects), or another connection's stream replay,
// joined by its id to watch it (its timeline stays its owner's).
// A consumer that falls behind (its send buffer is full) misses live and stream frames; nothing queues up.
import { randomBytes } from "node:crypto";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { describeError, NotFoundError, ValueError } from "@mrs6000/server-common/errors";
import { fromAllowedOrigin } from "@mrs6000/server-common/http";
import { log } from "@mrs6000/server-common/log";
import type { SensorFrame } from "@mrs6000/server-common/sensor/core";
import { frameMessage, type Frame, type Header } from "@mrs6000/wire/frame";
import { ACTIONS, SOURCE_PROTOCOL, type FrameMeta, type ReplayMode } from "@mrs6000/wire/source";
import { Crop } from "./crop";
import type { Hub } from "./hub";
import type { Replay, ReplayFrame } from "./replay";
import type { Rig } from "./rig";
import type { Store } from "./store";

export const MAX_BUFFERED = 8 * 1024 * 1024;
export const STATUS_S = 1;

export interface Conn {
  id: string; name: string; hello: boolean; registered: boolean;
  source: string | null;                     // "live" or a replay id
  owns: boolean;                             // its replay ends with it
  layouts: Map<string, Header>; sent: number; dropped: number; since: number;
}

type WS = ServerWebSocket<Conn>;

export interface ConsumerInfo {
  id: string; name: string; registered: boolean; source: string | null; owns: boolean;   // owns: started the replay it watches
  sent: number; dropped: number; since: number;
}

export class Consumers {
  private conns = new Set<WS>();
  private crop = new Crop();
  private rigs = new Map<string, { version: number; rig: Rig }>();   // each source's rig, as of its version (frames come far more often than it changes)
  private timer: ReturnType<typeof setInterval>;
  readonly websocket: WebSocketHandler<Conn>;

  constructor(private hub: Hub, private store: Store) {
    hub.events = {
      liveFrame: (sensor, f) => this.frame("live", sensor, f, f.hdr, { k: f.seq, t: f.t, rate: f.rate, epoch: 0 }),
      liveChanged: () => {                                     // live consumers subscribe afresh: other sensors, new layouts
        for (const ws of [...this.on("live")]) { ws.data.source = null; this.watch(ws, "live", false); }
      },
      rig: (source, rig, version) => this.send(source, { type: "rig", source, version, rig }),
      replayClosed: (id, reason) => {
        this.rigs.delete(id);
        for (const ws of this.on(id)) { this.out(ws, { type: "closed", source: id, reason }); ws.data.source = null; ws.close(4004, reason); }
      },
    };
    this.websocket = {
      open: ws => { this.conns.add(ws); },
      message: (ws, m) => this.message(ws, m),
      close: ws => { this.leave(ws); this.conns.delete(ws); },
    };
    this.timer = setInterval(() => this.send("live", { type: "status", sensors: this.hub.live.map(s => s.info()) }), STATUS_S * 1000);
  }

  /** answer a /ws request (true: upgraded); a browser page from another site is refused */
  upgrade(req: Request, server: Server<Conn>): boolean | Response {
    if (!fromAllowedOrigin(req, this.store.data.origins)) return new Response("origin not allowed", { status: 403 });
    const data: Conn = { id: randomBytes(4).toString("hex"), name: "", hello: false, registered: false, source: null, owns: false,
                         layouts: new Map(), sent: 0, dropped: 0, since: Date.now() / 1000 };
    return server.upgrade(req, { data });
  }

  list(): ConsumerInfo[] {
    return [...this.conns].filter(w => w.data.hello).map(({ data: c }) => ({ id: c.id, name: c.name, registered: c.registered, source: c.source,
                                                                              owns: c.owns, sent: c.sent, dropped: c.dropped, since: c.since }));
  }

  close(): void { clearInterval(this.timer); for (const ws of this.conns) ws.close(1001, "server stopping"); }

  private message(ws: WS, raw: string | Buffer): void {
    let m: Record<string, unknown>;
    try { m = JSON.parse(String(raw)); } catch { return this.error(ws, "expected JSON"); }
    try {
      if (m.type === "hello") return this.hello(ws, m);
      if (!ws.data.hello) return this.error(ws, "say hello first");
      switch (m.type) {
        case "subscribe":
          if (m.source !== "live") throw new ValueError('subscribe: source "live" (replays: "replay" or "join")');
          return this.watch(ws, "live", false);
        case "replay": {
          if (typeof m.recording !== "string") throw new ValueError("recording: a recording name");
          const mode = m.mode === "pull" ? "pull" : m.mode === undefined || m.mode === "stream" ? "stream" : null;
          if (!mode) throw new ValueError("mode: stream or pull");
          return this.startReplay(ws, m.recording, mode);
        }
        case "join": {
          const r = this.hub.replay(String(m.source));
          if (r.mode !== "stream") throw new ValueError("join: only a stream replay can be watched (a pull replay is one consumer's batch)");
          r.consumers++;
          return this.watch(ws, r.id, false);
        }
        case "control": {
          const r = this.ownReplay(ws);
          if (!ACTIONS.includes(m.action as never)) throw new ValueError(`action: one of ${ACTIONS.join(", ")}`);
          r.control(String(m.action), m.value ?? null);
          return;
        }
        case "credit": return this.ownReplay(ws).grant(Number(m.n));
        default: return this.error(ws, `unknown message ${JSON.stringify(m.type)}`);
      }
    } catch (e) {
      this.error(ws, e instanceof NotFoundError ? `not found: ${e.message}` : describeError(e));   // as the HTTP API says it
    }
  }

  private hello(ws: WS, m: Record<string, unknown>): void {
    const c = ws.data, entry = this.store.consumerByToken(typeof m.token === "string" ? m.token : undefined);
    if (!entry && (m.token !== undefined || !this.store.data.open)) { this.error(ws, "unknown consumer"); ws.close(4001, "unknown consumer"); return; }
    c.name = entry?.name ?? (typeof m.name === "string" ? m.name.slice(0, 80) : "anonymous");
    c.registered = !!entry;
    c.hello = true;
    this.out(ws, { type: "welcome", server: "mrs6000 source", sensors: this.hub.liveNames() });
    log(`consumer ${c.name} (${c.id}) connected`);
  }

  private startReplay(ws: WS, recording: string, mode: ReplayMode): void {
    const r: Replay = this.hub.createReplay(recording, mode, {
      frame: f => this.replayFrame(r, f),
      state: () => this.send(r.id, { type: "state", source: r.id, replay: r.player.state(), error: r.error }),
      end: () => this.send(r.id, { type: "end", source: r.id }),
    }, ws.data.name);
    this.watch(ws, r.id, true);
  }

  /** start watching a source: what it is, its rig, then frames (each sensor's layout before its first) */
  private watch(ws: WS, source: string, owns: boolean): void {
    if (ws.data.source !== null) throw new ValueError("this connection watches a source already (one per connection)");
    const c = ws.data;
    c.source = source; c.owns = owns; c.layouts.clear();
    const r = source === "live" ? null : this.hub.replay(source);
    this.out(ws, { type: "subscribed", source, sensors: r ? r.sensors : this.hub.liveNames(), mode: r ? r.mode : "live",
                   ...(r ? { recording: r.name, count: r.rec.count, owner: r.owner, controls: owns } : {}) });
    this.out(ws, { type: "rig", source, version: this.hub.rigVersionOf(source), rig: this.hub.rig(source) });
    if (r?.mode === "stream") this.out(ws, { type: "state", source, replay: r.player.state(), error: r.error });
  }

  private leave(ws: WS): void {
    const { source, owns } = ws.data;
    ws.data.source = null;
    if (!source || source === "live") return;
    const r = this.hub.replays.get(source);
    if (!r) return;
    r.consumers = Math.max(0, r.consumers - 1);
    if (owns) this.hub.closeReplay(source, "its consumer left");
  }

  private ownReplay(ws: WS): Replay {
    if (!ws.data.source || ws.data.source === "live") throw new ValueError("not replaying a recording");
    if (!ws.data.owns) throw new ValueError(`only ${this.hub.replay(ws.data.source).owner || "the server that started it"} controls this replay`);
    return this.hub.replay(ws.data.source);
  }

  private *on(source: string): Generator<WS> { for (const ws of this.conns) if (ws.data.source === source) yield ws; }

  private replayFrame(r: Replay, f: ReplayFrame): void {
    this.frame(r.id, f.sensor, f.frame, f.hdr, { k: f.k, t: f.frame.t, rate: f.rate, epoch: f.epoch }, r.mode === "pull");
  }

  /** a frame to everyone on `source` (pull mode: never dropped, the credit bounds it) */
  private frame(source: string, sensor: string, f: Frame | SensorFrame, hdr: Header, meta: Pick<FrameMeta, "k" | "t" | "rate" | "epoch">, keep = false): void {
    let msg: Uint8Array | null = null;
    for (const ws of this.on(source)) {
      const c = ws.data;
      if (c.layouts.get(sensor) !== hdr) { this.out(ws, { type: "layout", source, sensor, hdr }, true); c.layouts.set(sensor, hdr); }
      if (!keep && ws.getBufferedAmount() > MAX_BUFFERED) { c.dropped++; continue; }
      if (!msg) {
        const g = this.cut(source, sensor, f, hdr);
        msg = frameMessage({ v: SOURCE_PROTOCOL, type: "frame", source, sensor, ...meta } satisfies FrameMeta, g.d, g.r);
      }
      ws.sendBinary(msg);
      c.sent++;
    }
  }

  /** the frame without the beams outside the sensor's region, if its rig entry has one (rig.ts) */
  private cut(source: string, sensor: string, f: Frame | SensorFrame, hdr: Header): Frame | SensorFrame {
    const version = this.hub.rigVersionOf(source);
    let c = this.rigs.get(source);
    if (c?.version !== version) this.rigs.set(source, c = { version, rig: this.hub.rig(source) });
    const entry = c.rig.sensors.find(s => s.name === sensor);
    return entry?.region ? this.crop.apply(sensor, f, hdr, entry, this.hub.mounts([sensor])[0]) : f;
  }

  /** a JSON message to everyone on a source */
  private send(source: string, m: Record<string, unknown>): void { for (const ws of this.on(source)) this.out(ws, m); }

  /** a JSON message to one consumer, unless it is behind (`always`: layouts, which frames depend on) */
  private out(ws: WS, m: Record<string, unknown>, always = false): void {
    if (!always && ws.getBufferedAmount() > MAX_BUFFERED) { ws.data.dropped++; return; }
    ws.send(JSON.stringify({ v: SOURCE_PROTOCOL, ...m }));
  }

  private error(ws: WS, message: string): void { this.out(ws, { type: "error", message }, true); }
}
