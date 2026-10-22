// A processing server's connection to the source server (libs/wire/src/source.ts): one WebSocket per source it
// watches. The live sensors' connection comes back by itself after the source restarts (a new `subscribed`, so the
// consumer resets); a replay belongs to its connection and ends with it.
import type { Header } from "@mrs6000/wire/frame";
import { readFrameMessage } from "@mrs6000/wire/frame";
import type { Rig } from "@mrs6000/wire/rig";
import type { Action, FrameMeta, FromSource, PlayerState, ReplayMode, SensorStatus, ToSource } from "@mrs6000/wire/source";
import type { SensorFrame } from "./sensor/core";
import { describeError } from "./errors";

/** where the source server is and how to introduce oneself */
export interface SourceAddress { url: string; name: string; token?: string }

export type Watch = { kind: "live" } | { kind: "replay"; recording: string; mode: ReplayMode } | { kind: "join"; source: string };

export interface Subscribed { source: string; sensors: string[]; mode: "live" | ReplayMode; recording?: string; count?: number; owner?: string; controls?: boolean }

/** a frame from the source: the recorded values, its layout, its sensor; `seq` is its index (replay) or scan counter */
export interface SourceFrame extends SensorFrame { sensor: string; epoch: number }

export interface SourceEvents {
  subscribed?(s: Subscribed): void;          // (again after a reconnect: start the histories afresh)
  rig?(rig: Rig, version: number): void;
  frame?(f: SourceFrame): void;
  state?(replay: PlayerState, error: string): void;
  status?(sensors: SensorStatus[]): void;
  end?(): void;                              // pull mode: every frame has been sent
  closed?(reason: string): void;             // the source ended (a replay's connection closed, its recording was deleted)
  error?(message: string): void;
  connection?(up: boolean, error: string): void;
}

export const wsUrl = (http: string): string => http.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";

export class SourceConnection {
  private ws: WebSocket | null = null;
  private layouts = new Map<string, Header>();
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  info: Subscribed | null = null;
  up = false;
  error = "";

  constructor(readonly address: SourceAddress, readonly watch: Watch, private events: SourceEvents, readonly retryMs = 2000) {
    this.connect();
  }

  get source(): string | null { return this.info?.source ?? null; }

  control(action: Action, value: number | boolean | null = null): void { this.send({ type: "control", action, value }); }
  credit(n: number): void { this.send({ type: "credit", n }); }

  close(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close(1000, "done");
    this.ws = null;
  }

  private send(m: ToSource): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }

  private connect(): void {
    const ws = new WebSocket(wsUrl(this.address.url));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.send({ type: "hello", role: "processing", name: this.address.name, token: this.address.token });
      const w = this.watch;
      this.send(w.kind === "live" ? { type: "subscribe", source: "live" }
              : w.kind === "replay" ? { type: "replay", recording: w.recording, mode: w.mode } : { type: "join", source: w.source });
    };
    ws.onmessage = e => {
      try {
        if (typeof e.data === "string") this.message(JSON.parse(e.data) as FromSource);
        else this.frame(new Uint8Array(e.data as ArrayBuffer));
      } catch (err) { this.events.error?.(`source: ${describeError(err)}`); }
    };
    ws.onerror = () => { this.error = `source ${this.address.url}: cannot connect`; };
    ws.onclose = e => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.up;
      this.up = false;
      if (e.code === 4001 || e.code === 4004) this.stopped = true;          // refused, or its source is gone: no point retrying
      if (was || !this.error) this.error = `source ${this.address.url}: ${e.reason || "connection closed"}`;
      this.events.connection?.(false, this.error);
      if (this.watch.kind !== "live") {                                    // a replay is gone with its connection
        this.stopped = true;
        if (this.info) this.events.closed?.(e.reason || "connection closed"); else this.events.error?.(this.error);
      }
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), this.retryMs);
    };
  }

  private message(m: FromSource): void {
    switch (m.type) {
      case "welcome": break;
      case "subscribed":
        this.info = { source: m.source, sensors: m.sensors, mode: m.mode, recording: m.recording, count: m.count, owner: m.owner, controls: m.controls };
        this.layouts.clear();
        this.up = true; this.error = "";
        this.events.connection?.(true, "");
        this.events.subscribed?.(this.info);
        break;
      case "rig": this.events.rig?.(m.rig, m.version); break;
      case "layout": this.layouts.set(m.sensor, m.hdr); break;
      case "state": this.events.state?.(m.replay, m.error); break;
      case "status": this.events.status?.(m.sensors); break;
      case "end": this.events.end?.(); break;
      case "closed": this.stopped = true; this.events.closed?.(m.reason); break;
      case "error": this.error = m.message; this.events.error?.(m.message); break;
    }
  }

  private frame(b: Uint8Array): void {
    const { meta, d, r } = readFrameMessage(b), m = meta as unknown as FrameMeta, hdr = this.layouts.get(m.sensor);
    if (!hdr) return;                                            // a layout always comes first
    this.events.frame?.({ sensor: m.sensor, seq: m.k, t: m.t, rate: m.rate, epoch: m.epoch, d, r, hdr });
  }
}

/** GET a JSON resource of the source server's API (the recordings, its sensors) */
export async function sourceGet<T>(address: SourceAddress, path: string): Promise<T> {
  const r = await fetch(address.url.replace(/\/$/, "") + path, { headers: address.token ? { Authorization: `Bearer ${address.token}` } : {} });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `source: HTTP ${r.status}`);
  return body as T;
}
