// What the debug server holds: the live view (always connected), the pages' replays (each a View of its own, ended
// once no page has asked about it for a while; one the page started itself, or another processing server's replay it
// watches), and the source's state (its recording, the other servers' replays), polled for the page.
import type { Config } from "@mrs6000/processing/config/config";
import { NotFoundError, ValueError } from "@mrs6000/server-common/errors";
import { log } from "@mrs6000/server-common/log";
import { sourceGet, type SourceAddress, type Watch } from "@mrs6000/server-common/sourceClient";
import type { PlayerState } from "@mrs6000/wire/source";
import { View } from "./view";

export const SESSION_GRACE_S = 30;           // a replay no page has asked about ends after this long

export interface PageState {
  source: "live" | "replay"; session: string | null; default_session: string | null; epoch: number; replay: View["replay"];
  recording: Record<string, unknown>; live_error: string; replay_error: string; sensor: boolean; sensors: string[];
  rig_version: number; source_url: string;
  controls: boolean;                         // a replay the page may drive (its own); false for another server's
  owner: string | null;                      // whose replay it is: this server's name, or the other server's
}

/** another processing server's replay at the source, which a page may watch */
export interface OtherReplay { id: string; recording: string; owner: string; sensors: string[]; consumers: number; replay: PlayerState }

export class Hub {
  live: View;
  readonly sessions = new Map<string, View>();
  defaultSession: string | null = null;      // the "replay" setting's: what a page shows unless told otherwise
  recording: Record<string, unknown> = { active: false, error: "" };
  private timer: ReturnType<typeof setInterval>;

  constructor(public source: SourceAddress, public cfg: Config, public objects = true) {
    this.live = this.liveView();
    this.timer = setInterval(() => this.housekeeping(), 2000);
  }

  private liveView(): View {
    const v = new View(this.source, { kind: "live" }, this.cfg, this.objects);
    v.keep = true;
    return v;
  }

  /** another source server (or name, or token), or the own objects on or off: every view starts afresh, the pages'
   *  replays end */
  reconnect(source: SourceAddress, objects: boolean): void {
    this.source = source; this.objects = objects;
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
    this.live.close();
    this.live = this.liveView();
  }

  /** the replay every page opens first ("" for none): the new one is started before the old one ends */
  async setDefaultReplay(recording: string): Promise<void> {
    const old = this.defaultSession;
    const v = recording ? await this.createSession(recording) : null;
    if (v) v.keep = true;
    if (old) this.closeSession(old);
    this.defaultSession = v?.id ?? null;
  }

  shutdown(): void {
    clearInterval(this.timer);
    this.live.close();
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  setConfig(cfg: Config): void {
    this.cfg = cfg;
    for (const v of [this.live, ...this.sessions.values()]) v.pipeline.setConfig(cfg);
  }

  /** the live view, or a replay (404 for one that ended); asking keeps it alive */
  view(session: string | null): View {
    if (session === null) return this.live;
    const v = this.sessions.get(session);
    if (!v) throw new NotFoundError(`session ${session}`);
    v.touch();
    return v;
  }

  /** a replay of a recording, once the source has started it */
  createSession(recording: string): Promise<View> { return this.open({ kind: "replay", recording, mode: "stream" }); }

  /** watch another processing server's replay (its id at the source); its owner keeps the timeline */
  joinSession(source: string): Promise<View> {
    const mine = [...this.sessions.values()].some(v => v.sourceId === source);
    if (mine) throw new ValueError("that replay is one of this server's own");
    return this.open({ kind: "join", source });
  }

  private async open(watch: Watch): Promise<View> {
    const v = new View(this.source, watch, this.cfg, this.objects);
    this.sessions.set(v.id, v);
    v.onClosed = reason => { log(`session ${v.id.slice(0, 8)}: ${reason}`); this.closeSession(v.id); };
    try {
      await v.ready;
    } catch (e) {
      this.closeSession(v.id);
      const msg = e instanceof Error ? e.message : String(e);
      throw msg.startsWith("not found: ") ? new NotFoundError(msg.slice("not found: ".length)) : e;
    }
    log(`session ${v.id.slice(0, 8)}: ${v.controls ? "replaying" : `watching ${v.owner}'s replay of`} ${v.recording}`);
    return v;
  }

  /** the other processing servers' stream replays at the source (not this server's own) */
  async otherReplays(): Promise<OtherReplay[]> {
    const s = await sourceGet<{ replays: (OtherReplay & { mode: string })[] }>(this.source, "/api/state");
    const mine = new Set([...this.sessions.values()].filter(v => v.controls).map(v => v.sourceId));
    return s.replays.filter(r => r.mode === "stream" && !mine.has(r.id))
      .map(r => ({ id: r.id, recording: r.recording, owner: r.owner, sensors: r.sensors, consumers: r.consumers, replay: r.replay }));
  }

  closeSession(id: string): void {
    const v = this.sessions.get(id);
    if (!v) return;
    v.close();
    this.sessions.delete(id);
    if (this.defaultSession === id) this.defaultSession = null;
  }

  state(session: string | null): PageState {
    const v = this.view(session);
    return { source: v.live ? "live" : "replay", session: v.live ? null : v.id, default_session: this.defaultSession, epoch: v.epoch, replay: v.replay,
             recording: this.recording, live_error: this.live.liveError(), replay_error: v.live ? "" : v.error,
             sensor: this.live.sensors.length > 0, sensors: v.sensors, rig_version: v.pipeline.rigVersion, source_url: this.source.url,
             controls: v.controls, owner: v.live ? null : v.owner };
  }

  /** a view's sensors: name, and for live ones their address, error, rate, clock and device */
  sensorInfo(session: string | null): Record<string, unknown>[] {
    const v = this.view(session);
    return v.sensors.map(name => {
      const s = v.live ? this.live.status.find(x => x.name === name) : null;
      return s ? { name, live: true, ip: s.ip, error: s.error, rate: s.rate, clock: s.clock, device: s.device, upside_down: s.upside_down } : { name, live: false };
    });
  }

  private housekeeping(): void {
    const now = performance.now();
    for (const v of [...this.sessions.values()])
      if (!v.keep && now - v.lastUsed > SESSION_GRACE_S * 1000) { log(`session ${v.id.slice(0, 8)}: nobody watching`); this.closeSession(v.id); }
    sourceGet<{ recording: Record<string, unknown> }>(this.source, "/api/state").then(s => { this.recording = s.recording; }, () => {});
  }
}
