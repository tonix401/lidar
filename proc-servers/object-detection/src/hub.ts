// What an object-detection server holds: the live sensors' processing (always running, its fused tracks sent to the
// clients watching live), the clients' replays, and background jobs filling the track cache. The clients (ws.ts) and
// the HTTP API (http.ts) only call these methods.
import type { Config } from "@mrs6000/processing/config/config";
import { NotFoundError, ValueError } from "@mrs6000/server-common/errors";
import { log } from "@mrs6000/server-common/log";
import { SourcePipeline } from "@mrs6000/server-common/pipeline";
import type { ObjectsTick } from "@mrs6000/server-common/sensorSet";
import type { SourceAddress } from "@mrs6000/server-common/sourceClient";
import type { Rig } from "@mrs6000/wire/rig";
import type { SensorStatus } from "@mrs6000/wire/source";
import { BatchJob } from "./batch";
import { ClientReplay } from "./replay";
import { dropCache, cacheDir } from "./trackCache";

export interface HubEvents {
  objects?(source: string, tick: ObjectsTick): void;        // "live" or a replay's id
  state?(r: ClientReplay): void;
  closed?(id: string, reason: string): void;
}

export interface HubState {
  name: string; source: { url: string; up: boolean; error: string }; sensors: string[]; status: SensorStatus[]; rig: Rig;
  replays: number; jobs: ReturnType<BatchJob["state"]>[];
}

export class Hub {
  live: SourcePipeline | null = null;
  readonly replays = new Map<string, ClientReplay>();
  readonly jobs = new Map<string, BatchJob>();
  events: HubEvents = {};
  status: SensorStatus[] = [];
  maxProcessing = 2;

  /** `cacheRoot`: this server's folder of the track cache */
  constructor(public name: string, public source: SourceAddress, public cfg: Config, public cacheRoot: string) {}

  /** another name, source server or token: the clients' replays and the background jobs end, the live processing
   *  starts afresh (the clients watching live stay) */
  reconnect(name: string, source: SourceAddress, cacheRoot: string): void {
    for (const j of this.jobs.values()) j.cancel();
    this.jobs.clear();
    for (const r of [...this.replays.values()]) this.closeReplay(r.id, "the server's source changed");
    this.live?.close();
    Object.assign(this, { name, source, cacheRoot });
    this.start();
  }

  start(): void {
    this.live = new SourcePipeline(this.source, { kind: "live" }, this.cfg, {
      objects: t => this.events.objects?.("live", t),
      status: s => { this.status = s; },
      subscribed: s => log(`live: ${s.sensors.join(", ") || "no sensors"} from ${this.source.url}`),
      error: e => log(`live: ${e}`),
    });
  }

  async shutdown(): Promise<void> {
    for (const j of this.jobs.values()) j.cancel();
    for (const r of [...this.replays.values()]) this.closeReplay(r.id, "server stopping");
    this.live?.close();
  }

  setConfig(cfg: Config): void {
    this.cfg = cfg;
    this.live?.setConfig(cfg);
    for (const r of this.replays.values()) r.setConfig(cfg);
  }

  liveRig(): Rig { return this.live?.rig ?? { sensors: [] }; }

  // --- replays ---
  replay(id: string): ClientReplay {
    const r = this.replays.get(id);
    if (!r) throw new NotFoundError(`replay ${id}`);
    return r;
  }

  createReplay(recording: string): ClientReplay {
    const r: ClientReplay = new ClientReplay(recording, this.source, this.cfg, this.cacheRoot, () => this.processing() < this.maxProcessing, {
      objects: t => this.events.objects?.(r.id, t),
      state: () => this.events.state?.(r),
      closed: reason => { if (this.replays.delete(r.id)) { r.close(); this.events.closed?.(r.id, reason); } },
    });
    this.replays.set(r.id, r);
    log(`replay ${r.id}: ${recording}`);
    return r;
  }

  closeReplay(id: string, reason = "closed"): void {
    const r = this.replays.get(id);
    if (!r) return;
    this.replays.delete(id);
    r.close();
    this.events.closed?.(id, reason);
  }

  /** replays with their own processing and background jobs */
  processing(): number {
    return [...this.replays.values()].filter(r => r.objects === "processing").length + [...this.jobs.values()].filter(j => j.running).length;
  }

  // --- the track cache ---
  /** compute a recording's tracks in the background (batch.ts) */
  processRecording(recording: string): BatchJob {
    const running = this.jobs.get(recording);
    if (running?.running) return running;
    if (this.processing() >= this.maxProcessing) throw new ValueError(`at most ${this.maxProcessing} replays with processing at once`);
    const job = new BatchJob(recording, this.source, this.cfg, this.cacheRoot);
    this.jobs.set(recording, job);
    return job;
  }

  dropCache(recording: string): void { dropCache(cacheDir(this.cacheRoot, recording)); }

  state(): HubState {
    const l = this.live;
    return { name: this.name, source: { url: this.source.url, up: !!l?.conn.up, error: l?.conn.error ?? "" }, sensors: l?.names ?? [], status: this.status,
             rig: this.liveRig(), replays: this.replays.size, jobs: [...this.jobs.values()].map(j => j.state()) };
  }
}
