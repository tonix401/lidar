// A replay: one consumer's own timeline through a recording, independent of the live sensors and of every other
// replay. It belongs to the connection that asked for it (ws.ts): only that one controls it, and it ends when that one
// disconnects. Other processing servers may watch a stream replay by its id (the debug server shows them).
//
//   stream — paced like the recording (play, pause, seek, speed, loop: player.ts); `epoch` increments whenever the
//            sequence is not continuous (seek, step back, loop wrap).
//   pull   — every frame in recorded order, as fast as the consumer grants credit, never one dropped.
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { describeError, ValueError } from "@mrs6000/server-common/errors";
import { Signal } from "@mrs6000/server-common/health";
import { nowS } from "@mrs6000/server-common/log";
import type { ReplayMode } from "@mrs6000/wire/source";
import { Player, type PlayerState } from "./player";
import type { Frame, Header } from "./recording/format";
import { openRecording, Session, type AnyRecording } from "./recording/session";
import { rigFor, type Rig } from "./rig";

export const STATE_S = 0.25;                  // stream mode: the position is sent this often while playing

export interface ReplayFrame { sensor: string; k: number; epoch: number; frame: Frame; hdr: Header; rate: number }

export interface ReplayEvents {
  frame?(f: ReplayFrame): void;
  state?(): void;                            // stream mode: play / pause / seek / end / error
  end?(): void;                              // pull mode: every frame sent
}

export interface ReplayInfo {
  id: string; recording: string; mode: ReplayMode; owner: string;   // the processing server that started it
  sensors: string[]; count: number; consumers: number; replay: PlayerState; error: string;
}

export class Replay {
  readonly id = randomBytes(5).toString("hex");
  readonly rec: AnyRecording;
  readonly player = new Player();
  epoch = 0;
  error = "";
  consumers = 1;
  rigVersion = 1;
  private credit = 0;                        // pull mode: frames the consumer may still receive
  private next = 0;                          // pull mode: the next frame
  private ended = false;                     // pull mode: `end` sent for the frames there are
  private changed = new Signal();
  private closed = false;
  private published = new Map<string, number>();
  private stateAt = 0;                       // stream mode: when the position was last sent

  constructor(readonly path: string, readonly mode: ReplayMode, private events: ReplayEvents = {}, readonly owner = "") {
    this.rec = openRecording(path);
    if (mode === "stream") this.player.load(openRecording(path));   // the player owns its own reader (it closes it on unload)
    setTimeout(() => void this.loop(), 0);    // after the constructor: the first frame's callback may use the replay
  }

  get name(): string { return basename(this.path); }
  get sensors(): string[] { return [...this.rec.sensors]; }

  /** the rig the recording was made with (a session's; a single file has none) */
  get rig(): Rig { return rigFor(this.rec instanceof Session ? (this.rec.meta.rig ?? { sensors: [] }) : { sensors: [] }, this.sensors); }

  /** stream mode: the transport */
  control(action: string, value: unknown = null): void {
    if (this.mode !== "stream") throw new ValueError("a pull replay has no transport");
    this.player.control(action, value);
    this.changed.notify();
    this.events.state?.();
  }

  /** pull mode: `n` more frames may be sent */
  grant(n: number): void {
    if (this.mode !== "pull") throw new ValueError("credit is for pull replays");
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new ValueError("credit: 1 to 1000 frames");
    this.credit += n;
    this.changed.notify();
  }

  info(): ReplayInfo {
    return { id: this.id, recording: this.name, mode: this.mode, owner: this.owner, sensors: this.sensors, count: this.rec.count, consumers: this.consumers,
             replay: this.mode === "stream" ? this.player.state() : { index: this.next - 1, count: this.rec.count }, error: this.error };
  }

  close(): void {
    this.closed = true;
    this.changed.notify();
    this.player.unload();
    this.rec.close();
  }

  private async loop(): Promise<void> {
    while (!this.closed) {
      try {
        if (this.mode === "stream") await this.step(); else await this.pull();
      } catch (e) {
        this.error = `${this.name}: ${describeError(e)}`;
        this.player.playing = false;
        this.events.state?.();
        await this.changed.wait(1);
      }
    }
  }

  /** pull mode: the next frame once there is credit for it */
  private async pull(): Promise<void> {
    while (!this.closed && this.credit <= 0) await this.changed.wait();
    if (this.closed) return;
    if (this.next >= this.rec.count) {
      if (!this.ended) { this.ended = true; this.events.end?.(); }
      await this.changed.wait(0.5);                             // a recording still being recorded grows
      return;
    }
    this.ended = false;
    const k = this.next++, { sensor, frame, hdr } = this.rec.rawFrame(k);
    this.credit--;
    this.events.frame?.({ sensor, k, epoch: 0, frame, hdr, rate: 10 });
  }

  /** stream mode: show one frame (and wait until the next is due) */
  private async step(): Promise<void> {
    const p = this.player;
    while (!this.closed && !p.due) await this.changed.wait();
    if (this.closed) return;
    const tStart = nowS(), wasPlaying = p.playing, nxt = p.nextFrame();
    if (!nxt) { await this.changed.wait(0.5); return; }       // nothing complete yet (file still being recorded)
    if (nxt.k !== p.shown + 1) this.epoch++;                  // a jump: the histories start afresh
    p.shown = nxt.k;
    const { sensor, frame, hdr } = (p.rec as AnyRecording).rawFrame(nxt.k), now = nowS(), last = this.published.get(sensor) ?? now - 0.1;
    this.published.set(sensor, now);
    this.events.frame?.({ sensor, k: nxt.k, epoch: this.epoch, frame, hdr, rate: 1 / Math.max(now - last, 1e-3) });
    if (wasPlaying !== p.playing || now - this.stateAt > STATE_S) { this.stateAt = now; this.events.state?.(); }   // reached the end; the position
    const deadline = tStart + nxt.delay;                      // recorded pace, minus decode time
    for (let rem; (rem = deadline - nowS()) > 0 && p.playing && !p.dirty && !this.closed; ) await this.changed.wait(rem);
  }
}
