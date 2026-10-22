// The playback state machine on its own: no timers.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Player } from "../src/player";
import { Recording } from "../src/recording/reader";
import { writeRecording } from "./helpers";

let player: Player;
beforeEach(() => {
  player = new Player();
  player.load(new Recording(writeRecording(join(mkdtempSync(join(tmpdir(), "play-")), "a.tpc"), 4, { dt: 0.1 })));
});
afterEach(() => player.unload());

/** what the Hub does per frame: take the next one and mark it shown */
const show = (p: Player) => { const r = p.nextFrame()!; p.shown = r.k; return r; };

describe("player", () => {
  it("plays at the recorded pace and speed", () => {
    expect(player.due).toBe(true);
    let r = show(player);
    expect(r.k).toBe(0); expect(r.delay).toBeCloseTo(0.1, 9);
    player.control("speed", 3.5);                                 // the nearest of SPEEDS
    expect(player.speed).toBe(4);
    r = show(player);
    expect(r.k).toBe(1); expect(r.delay).toBeCloseTo(0.025, 9);
  });

  it("loops or stops at the end", () => {
    for (let k = 0; k < 4; k++) expect(show(player).k).toBe(k);
    expect([player.index, player.playing]).toEqual([0, true]);    // loop: wraps, short pause before frame 0
    player.control("loop", false);
    player.index = 3;
    expect(show(player)).toEqual({ k: 3, delay: 0 });
    expect([player.playing, player.due]).toEqual([false, false]);
    player.control("play");                                        // at the end without loop: starts over
    expect([player.index, player.playing]).toEqual([0, true]);
  });

  it("pause, step, seek", () => {
    show(player);
    player.control("toggle");
    expect([player.playing, player.due]).toEqual([false, false]);
    player.control("step", 2);                                     // from the shown frame
    expect([player.index, player.due]).toEqual([2, true]);
    expect(show(player)).toEqual({ k: 2, delay: 0 });
    expect(player.due).toBe(false);                                // paused: shown once
    player.control("step", -10);
    expect(player.index).toBe(0);
    player.control("seek", 99);
    expect(player.index).toBe(3);
  });

  it("state and errors", () => {
    show(player);
    const st = player.state();
    expect([st.file, st.count, st.index, st.upside_down]).toEqual(["a.tpc", 4, 0, true]);
    expect(st.duration).toBeCloseTo(0.3, 9);
    for (const [action, value] of [["seek", null], ["speed", null], ["jump", 1]] as const) expect(() => player.control(action, value)).toThrow();
    player.unload();
    expect(player.state()).toEqual({});
    expect(player.due).toBe(false);
    expect(() => player.control("play")).toThrow("not replaying");
  });
});
