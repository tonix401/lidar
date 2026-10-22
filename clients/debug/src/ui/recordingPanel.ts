// The source's recording state, the recordings list (name, duration, play; size and details in its tooltip), the
// other processing servers' replays (click one to watch it) and the transport bar for replays, which only shows the
// position of a replay another server drives. Recording, downloading and deleting are done on the source's page.
import type { Api, ControlAction } from "../api/client";
import { fmtMB, fmtTime } from "@mrs6000/processing/core/format";
import type { OtherReplay, RecordingInfo, ReplayState, ServerState } from "@mrs6000/processing/core/types";
import { $, el } from "./dom";

export interface RecordingEvents {
  state(s: ServerState): void;          // a fresh server state after an action
  error(e: unknown): void;              // failed action
}

export class RecordingPanel {
  private srv: ServerState | null = null;
  private seeking = false;
  private listAt = 0;
  private listSig = "";

  constructor(private api: Api, private ev: RecordingEvents) {
    const act = (p: Promise<ServerState>) => p.then(s => ev.state(s)).catch(e => ev.error(e));
    $("tPlay").onclick = () => act(this.control("toggle"));
    $("tStepB").onclick = () => act(this.control("step", -1));
    $("tStepF").onclick = () => act(this.control("step", 1));
    $<HTMLSelectElement>("tSpeed").onchange = e => act(this.control("speed", +(e.target as HTMLSelectElement).value));
    $<HTMLInputElement>("tLoop").onchange = e => act(this.control("loop", (e.target as HTMLInputElement).checked));
    $("tLive").onclick = () => act(this.api.live());
    const seek = $<HTMLInputElement>("tSeek");
    seek.addEventListener("input", () => {                       // while dragging: show the target time only
      this.seeking = true;
      const rp = this.srv?.replay ?? {}, f = (rp.count ?? 0) > 1 ? +seek.value / (rp.count! - 1) : 0;
      $("tTime").textContent = `${fmtTime(f * (rp.duration ?? 0))} / ${fmtTime(rp.duration)}`;
    });
    seek.addEventListener("change", () => { this.seeking = false; act(this.control("seek", +seek.value)); });
  }

  control(action: ControlAction, value?: number | boolean): Promise<ServerState> { return this.api.control(action, value); }

  get replaying(): boolean { return this.srv?.source === "replay"; }
  /** the replay is the page's own (another server's is only watched) */
  get controls(): boolean { return this.srv?.controls !== false; }
  get playing(): boolean { return !!this.srv?.replay.playing; }

  apply(s: ServerState): void {
    this.srv = s;
    const rec = s.recording, rp = s.replay, replay = s.source === "replay";
    const src = $<HTMLAnchorElement>("sourceLink");
    if (s.source_url) src.href = s.source_url;
    src.hidden = !s.source_url;
    $("recInfo").textContent = rec.active
      ? `the source is recording ${rec.file} · ${fmtTime(rec.seconds)} · ${rec.scans} scans · ${fmtMB(rec.bytes ?? 0)}` + (replay ? " (live stream, while you watch the replay)" : "")
      : rec.error ? rec.error : "";
    $("srcLabel").textContent = replay ? "replay" : !s.sensor ? "offline (no sensor)" : s.live_error ? "live sensor (not connected)" : "live sensor";
    $("transport").hidden = !replay;
    if (replay) this.transport(rp);
    this.watchOnly(replay && !this.controls ? s.owner ?? "another server" : null);
    const sig = `${rec.active}|${rec.file}|${rp.file}|${s.session ?? ""}`;   // what is recorded, what is watched
    if (sig !== this.listSig || performance.now() - this.listAt > (rec.active ? 2000 : 5000)) { this.listSig = sig; void this.loadList(); }
  }

  transport(rp: Partial<ReplayState>): void {
    if (!rp.count) return;
    $("tFile").textContent = rp.file ?? ""; $("tFile").title = rp.file ?? "";
    const seek = $<HTMLInputElement>("tSeek");
    seek.max = String(rp.count - 1);
    if (!this.seeking) { seek.value = String(rp.index ?? 0); $("tTime").textContent = `${fmtTime(rp.t)} / ${fmtTime(rp.duration)}`; }
    $("tPlay").textContent = rp.playing ? "⏸" : "▶";
    $<HTMLSelectElement>("tSpeed").value = String(rp.speed);
    $<HTMLInputElement>("tLoop").checked = !!rp.loop;
  }

  /** another server drives the replay: the controls show its position but are off */
  private watchOnly(owner: string | null): void {
    for (const id of ["tPlay", "tStepB", "tStepF", "tSeek", "tSpeed", "tLoop"]) $<HTMLInputElement>(id).disabled = owner !== null;
    $("tOwner").hidden = owner === null;
    $("tOwner").textContent = owner === null ? "" : `watching ${owner}'s replay`;
    $("tOwner").title = owner === null ? "" : `${owner} drives this replay's timeline; this page follows it`;
  }

  async loadList(): Promise<void> {
    this.listAt = performance.now();
    let list: RecordingInfo[], others: OtherReplay[] = [];
    try { list = await this.api.recordings(); } catch { return; }
    try { others = await this.api.others(); } catch { /* an older server: none */ }
    this.renderList(list);
    this.renderOthers(others);
  }

  renderOthers(list: OtherReplay[]): void {
    $("otherHead").hidden = !list.length;
    $("otherList").replaceChildren(...list.map(r => {
      const cur = this.replaying && !this.controls && this.srv?.owner === r.owner && this.srv?.replay.file === r.recording;
      const row = el("div", { className: "rrow" + (cur ? " cur" : ""), title: `${r.owner} is replaying ${r.recording}; click to watch it here`,
                              onclick: () => this.api.watch(r.id).then(s => this.ev.state(s)).catch(e => this.ev.error(e)) },
        el("span", { className: "nm", textContent: r.recording.replace(/\.(tpc(\.zstd)?|mrsstream)$/, "") }),
        el("span", { className: "mt", textContent: `${r.owner} · ${fmtTime(r.replay.t)}${r.replay.playing === false ? " (paused)" : ""}` }));
      return row;
    }));
  }

  renderList(list: RecordingInfo[]): void {
    const host = $("recList"), rec = this.srv?.recording, cur = this.replaying ? this.srv?.replay.file : undefined;
    if (!list.length) { host.replaceChildren(el("div", { className: "note2", textContent: "no recordings yet" })); return; }
    host.replaceChildren(...list.map(r => {
      const recording = !!rec?.active && rec.file === r.name;
      const run = () => this.api.replay(r.name).then(s => this.ev.state(s)).catch(e => this.ev.error(e));
      const play = el("button", { textContent: "▶", title: "play", disabled: !!r.error });
      play.onclick = e => { e.stopPropagation(); void run(); };
      const row = el("div", {
        className: "rrow" + (r.name === cur ? " cur" : "") + (recording ? " recording" : ""), onclick: () => { if (!r.error) void run(); },
        title: r.error ? r.error : details(r),
      }, el("span", { className: "nm", textContent: r.name.replace(/\.(tpc(\.zstd)?|mrsstream)$/, "") }),
         el("span", { className: "mt", textContent: r.error ? "unreadable" : fmtTime(r.seconds) + (r.sensors ? ` · ${r.sensors.length} sensors` : "") }));
      row.append(play);
      return row;
    }));
  }
}

/** a recording's size and details, for its tooltip */
const details = (r: RecordingInfo): string =>
  [r.name, `${fmtMB(r.bytes)} · ${r.scans} scans` + (r.sensors ? ` · ${r.sensors.join(", ")}` : ""),
   r.created ? `recorded ${new Date(r.created * 1000).toLocaleString()}` : ""].filter(Boolean).join("\n");
