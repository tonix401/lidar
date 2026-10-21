// Playback position in a recording: which frame to show next and when, and the transport controls. No timers:
// the Hub (or a replay session) drives it.
import { basename } from "node:path";
import { ValueError } from "./errors";
import type { AnyRecording } from "./recording/session";

export const SPEEDS = [0.25, 0.5, 1.0, 2.0, 4.0];
export const ACTIONS = ["play", "pause", "toggle", "step", "seek", "speed", "loop"] as const;
export type Action = (typeof ACTIONS)[number];

export interface PlayerState {
  file?: string; index?: number; count?: number; t?: number; duration?: number; playing?: boolean; speed?: number; loop?: boolean;
  upside_down?: boolean | null;
}

export class Player {
  rec: AnyRecording | null = null;          // recording being played
  index = 0;                                // next frame to show
  shown = -1;                               // last frame shown
  playing = true;
  dirty = false;                            // show `index` once even while paused
  speed = 1.0;                              // speed and loop stay when another file is loaded
  loop = true;

  load(rec: AnyRecording): void {
    this.unload();
    this.rec = rec; this.index = 0; this.shown = -1; this.playing = true; this.dirty = true;
  }

  unload(): void {
    try { this.rec?.close(); } catch { /* closed */ }
    this.rec = null;
  }

  /** a frame should be shown (playing, or a step/seek while paused) */
  get due(): boolean { return this.rec !== null && (this.playing || this.dirty); }

  /** the frame to show now and the seconds until the following one (recorded pace / speed); advances `index`.
   *  null while the recording has no complete frame yet. */
  nextFrame(): { k: number; delay: number } | null {
    const rec = this.rec!, n = rec.count;
    this.dirty = false;
    if (n === 0) return null;
    const k = Math.min(this.index, n - 1);
    let delay = 0, nxt = k + 1;                          // index always points at the next frame
    if (nxt >= n) {
      if (this.loop && this.playing) nxt = 0;
      else { nxt = k; this.playing = false; }
    }
    if (this.playing) delay = (nxt === k + 1 ? Math.min(0.5, Math.max(0, rec.time(nxt) - rec.time(k))) : 0.1) / this.speed;
    this.index = nxt;
    return { k, delay };
  }

  control(action: string, value: unknown = null): void {
    if (!this.rec) throw new ValueError("not replaying");
    const n = this.rec.count;
    switch (action) {
      case "play":
        if (!this.loop && this.shown >= n - 1) this.index = 0;
        this.playing = true;
        break;
      case "pause": this.playing = false; break;        // index already points at the next frame
      case "toggle": this.control(this.playing ? "pause" : "play"); break;
      case "step":
        this.playing = false;
        this.index = Math.max(0, Math.min(n - 1, this.shown + Math.trunc(Number(value ?? 1) || 1)));
        this.dirty = true;
        break;
      case "seek":
        if (value === null || value === undefined) throw new ValueError("seek needs a frame index");
        this.index = Math.max(0, Math.min(n - 1, Math.trunc(Number(value))));
        this.dirty = true;
        break;
      case "speed": {
        if (value === null || value === undefined) throw new ValueError("speed needs a value");
        const v = Number(value);
        this.speed = SPEEDS.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best));
        break;
      }
      case "loop": this.loop = !!value; break;
      default: throw new ValueError(`unknown action ${JSON.stringify(action)}`);
    }
  }

  state(): PlayerState {
    if (!this.rec) return {};
    const rec = this.rec, n = rec.count, t0 = n ? rec.time(0) : 0, cur = Math.max(0, Math.min(this.shown, n - 1));
    const r2 = (x: number) => Math.round(x * 100) / 100;
    return { file: basename(rec.path), index: cur, count: n, t: n ? r2(rec.time(cur) - t0) : 0, duration: n > 1 ? r2(rec.time(n - 1) - t0) : 0,
             playing: this.playing, speed: this.speed, loop: this.loop, upside_down: rec.hdr.upside_down ?? null };
  }
}
