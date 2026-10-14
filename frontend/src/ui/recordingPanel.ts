// Record button, recordings list (play / download / delete) and the transport bar for replays.
import type { Api, ControlAction } from "../api/client";
import { fmtMB, fmtTime } from "../core/format";
import type { RecordingInfo, ReplayState, ServerState } from "../core/types";
import { $, el } from "./dom";

export interface RecordingEvents {
  state(s: ServerState): void;          // a fresh server state after an action
  error(e: unknown): void;              // failed action
  confirm(msg: string): boolean;
}

export class RecordingPanel {
  private srv: ServerState | null = null;
  private seeking = false;
  private listAt = 0;
  private listSig = "";

  constructor(private api: Api, private ev: RecordingEvents) {
    const act = (p: Promise<ServerState>) => p.then(s => ev.state(s)).catch(e => ev.error(e));
    $("recBtn").onclick = () => act(this.api.record(this.srv?.recording.active ? "stop" : "start"));
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
  get playing(): boolean { return !!this.srv?.replay.playing; }

  apply(s: ServerState): void {
    this.srv = s;
    const rec = s.recording, rp = s.replay, replay = s.source === "replay";
    const btn = $<HTMLButtonElement>("recBtn");
    btn.textContent = rec.active ? "■ Stop" : "● Record";
    btn.classList.toggle("rec", rec.active);
    btn.disabled = !s.sensor;
    btn.title = s.sensor ? "Save the live sensor stream on the server (recordings/)" : "offline mode: no sensor to record";
    $("recInfo").textContent = rec.active
      ? `recording ${rec.file} · ${fmtTime(rec.seconds)} · ${rec.scans} scans · ${fmtMB(rec.bytes ?? 0)}` + (replay ? " (live stream, while you watch the replay)" : "")
      : rec.error ? rec.error : "saves the live sensor stream on the server in recordings/ (≈ 53 MB per minute)";
    $("srcLabel").textContent = replay ? "replay" : !s.sensor ? "offline (no sensor)" : s.live_error ? "live sensor (not connected)" : "live sensor";
    $("transport").hidden = !replay;
    if (replay) this.transport(rp);
    const sig = `${rec.active}|${rec.file}|${rp.file}`;
    if (sig !== this.listSig || performance.now() - this.listAt > (rec.active ? 2000 : 10000)) { this.listSig = sig; void this.loadList(); }
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

  async loadList(): Promise<void> {
    this.listAt = performance.now();
    let list: RecordingInfo[];
    try { list = await this.api.recordings(); } catch { return; }
    this.renderList(list);
  }

  renderList(list: RecordingInfo[]): void {
    const host = $("recList"), rec = this.srv?.recording, cur = this.replaying ? this.srv?.replay.file : undefined;
    if (!list.length) { host.replaceChildren(el("div", { className: "note2", textContent: "no recordings yet" })); return; }
    host.replaceChildren(...list.map(r => {
      const recording = !!rec?.active && rec.file === r.name;
      const play = el("button", { textContent: "▶", title: "play this recording", disabled: !!r.error });
      const dl = el("a", { textContent: "⬇", title: "download", href: this.api.downloadUrl(r.name), download: r.name });
      const del = el("button", { textContent: "🗑", title: recording ? "stop the recording first" : "delete", disabled: recording });
      const run = () => this.api.replay(r.name).then(s => this.ev.state(s)).catch(e => this.ev.error(e));
      play.onclick = e => { e.stopPropagation(); void run(); };
      dl.onclick = e => e.stopPropagation();
      del.onclick = e => {
        e.stopPropagation();
        if (!this.ev.confirm(`Delete ${r.name} (${fmtMB(r.bytes)})? This cannot be undone.`)) return;
        this.api.deleteRecording(r.name).then(l => this.renderList(l)).catch(err => this.ev.error(err));
      };
      const row = el("div", {
        className: "rrow" + (r.name === cur ? " cur" : ""), onclick: () => { if (!r.error) void run(); },
        title: r.error ? r.error : `${r.name}\n${r.scans} scans · recorded ${new Date((r.created ?? 0) * 1000).toLocaleString()}`,
      }, el("span", { className: "nm", textContent: (r.name === cur ? "▶ " : recording ? "● " : "") + r.name.replace(/\.mrsstream$/, "") }),
         el("span", { className: "mt", textContent: r.error ? "unreadable" : `${fmtTime(r.seconds)} · ${fmtMB(r.bytes)}` }));
      row.append(play, dl, del);
      return row;
    }));
  }
}
