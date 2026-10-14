"""What the browser sees: the live sensor or a recording being played back.

The live connection always runs (so recording works whatever is on screen); a player thread
publishes recording frames while source == "replay". `epoch` increments whenever the published
sequence is not continuous (source switch, seek, step back, loop wrap) so the client can reset its
per-beam history."""
from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Callable, Iterator

from ..errors import describe_error
from ..model import Scan
from .feed import Feed
from .frames import encode, meta_for_scan, scan_meta
from .health import Health, log, supervised
from .stream import Recorder, Recording

SPEEDS = (0.25, 0.5, 1.0, 2.0, 4.0)
ACTIONS = ("play", "pause", "toggle", "step", "seek", "speed", "loop")


class Hub:
    def __init__(self, feed: Feed, rec_dir: Path, scan_source: Callable[[], Iterator[Scan]] | None = None,
                 retry_s: float = 3.0):
        self.feed = feed
        self.scan_source = scan_source           # () -> iterator of live scans; None = no sensor
        self.retry_s = retry_s
        self.cond = threading.Condition()        # guards everything below (RLock based)
        self.stop_event = threading.Event()
        self.source = "live"
        self.rec: Recording | None = None        # recording being played
        self.index = 0                           # next frame to show
        self.shown = -1                          # last frame shown
        self.playing = True
        self.dirty = False                       # show `index` once even while paused
        self.speed = 1.0
        self.loop = True
        self.epoch = 0
        self.last_source: str | None = None
        self.live_error = ""
        self.replay_error = ""
        self.cola = Health("sensor (CoLa)", retry_s)
        self.replay_health = Health("replay")
        self.recorder = Recorder(rec_dir)
        self.threads: list[threading.Thread] = []

    # --- lifecycle ---
    def start(self):
        loops = [("player", self.player_loop)]
        if self.scan_source:
            loops.insert(0, ("sensor stream", self.live_loop))
        for name, fn in loops:
            t = threading.Thread(target=supervised, args=(name, fn, self.stop_event, self.retry_s),
                                 daemon=True, name=name)
            t.start()
            self.threads.append(t)

    def stop(self, timeout: float = 2.0):
        self.stop_event.set()
        with self.cond:
            self.cond.notify_all()
        for t in self.threads:
            t.join(timeout)
        self.recorder.stop()

    # --- publishing ---
    def publish(self, source: str, data: bytes, meta: dict, seq: int):
        with self.cond:
            if source != self.source:
                return
            if source != self.last_source or (source == "replay" and seq != self.shown + 1):
                self.epoch += 1
            self.last_source = source
            meta.update(source=source, epoch=self.epoch)
            if source == "replay":
                self.shown = seq
                meta["replay"] = self.replay_state()
        self.feed.publish(data, meta)

    def replay_state(self) -> dict:
        with self.cond:
            if not self.rec:
                return {}
            n = self.rec.count
            t0 = self.rec.time(0) if n else 0.0
            cur = max(0, min(self.shown, n - 1))
            return {"file": self.rec.path.name, "index": cur, "count": n,
                    "t": round(self.rec.time(cur) - t0, 2) if n else 0.0,
                    "duration": round(self.rec.time(n - 1) - t0, 2) if n > 1 else 0.0,
                    "playing": self.playing, "speed": self.speed, "loop": self.loop,
                    "upside_down": self.rec.hdr.get("upside_down")}

    # --- live sensor ---
    def live_loop(self):
        """Connect, stream, and on any failure (sensor off, unplugged, timeout, bad telegram) log one
        short line and reconnect every retry_s seconds."""
        k = 0
        while not self.stop_event.is_set():
            try:
                last = time.time()
                for scan in self.scan_source():
                    if self.stop_event.is_set():
                        return
                    now = time.time()
                    if self.cola.error:
                        self.cola.ok()
                        self.live_error = ""
                    self.recorder.upside_down = self.feed.status.get("UpsideDown")
                    self.recorder.write(scan, now)
                    if self.source == "live":
                        self.publish("live", encode(scan), meta_for_scan(scan, 1.0 / max(now - last, 1e-3), now), k)
                    k += 1
                    last = now
                self.live_error = "sensor: " + self.cola.fail("stream ended")
            except Exception as e:
                self.live_error = "sensor: " + self.cola.fail(e)
            self.stop_event.wait(self.retry_s)

    # --- playback ---
    def player_loop(self):
        last = time.time()
        while not self.stop_event.is_set():
            try:
                last = self._play_step(last)
            except Exception as e:
                with self.cond:
                    name = self.rec.path.name if self.rec else "recording"
                self.replay_error = self.replay_health.fail(f"{name}: {describe_error(e)}; back to live")
                self.go_live(keep_error=True)
                self.stop_event.wait(0.5)

    def _play_step(self, last: float) -> float:
        """Show one recording frame (and wait until the next is due); returns the publish time."""
        with self.cond:
            self.cond.wait_for(lambda: self.stop_event.is_set() or
                               (self.source == "replay" and self.rec and (self.playing or self.dirty)))
            if self.stop_event.is_set():
                return last
            rec, k = self.rec, self.index
            n = rec.count
            if n == 0:
                self.dirty = False
                self.cond.wait(0.5)
                return last
            t_start = time.time()
            k = min(k, n - 1)
            self.dirty = False
            ts, data, points = rec.encoded(k)
            delay, nxt = 0.0, k + 1                  # index always points at the next frame
            if nxt >= n:
                if self.loop and self.playing:
                    nxt = 0
                else:
                    nxt, self.playing = k, False
            if self.playing:
                delay = (min(0.5, max(0.0, rec.time(nxt) - ts)) if nxt == k + 1 else 0.1) / self.speed
            self.index = nxt
        now = time.time()
        meta = scan_meta(points, rec.L, rec.B, rec.hdr["start_azimuth_deg"], rec.hdr["step_deg"],
                         1.0 / max(now - last, 1e-3), ts)
        self.publish("replay", data, meta, k)
        deadline = t_start + delay                   # recorded pace, minus decode time
        with self.cond:   # wait for the next frame, but react at once to pause / seek / source change
            while (rem := deadline - time.time()) > 0 and self.playing and not self.dirty \
                    and self.source == "replay" and self.rec is rec and not self.stop_event.is_set():
                self.cond.wait(rem)
        return now

    # --- control (called from the API) ---
    def play_file(self, path: Path):
        rec = Recording(path)
        self.replay_error = ""
        self.replay_health.ok()
        log(f"replaying {Path(path).name}")
        with self.cond:
            if self.rec:
                self.rec.close()
            self.rec, self.index, self.shown, self.playing, self.dirty = rec, 0, -1, True, True
            self.source = "replay"
            self.cond.notify_all()

    def go_live(self, keep_error: bool = False):
        if not keep_error:
            self.replay_error = ""
        with self.cond:
            self.source = "live"
            if self.rec:
                try:
                    self.rec.close()
                except OSError:
                    pass
            self.rec = None
            self.cond.notify_all()

    def playing_file(self) -> Path | None:
        with self.cond:
            return self.rec.path if self.rec else None

    def control(self, action: str, value=None):
        with self.cond:
            if not self.rec:
                raise ValueError("not replaying")
            n = self.rec.count
            if action == "play":
                if not self.loop and self.shown >= n - 1:
                    self.index = 0
                self.playing = True
            elif action == "pause":
                self.playing = False             # index already points at the next frame
            elif action == "toggle":
                return self.control("pause" if self.playing else "play")
            elif action == "step":
                self.playing = False
                self.index = max(0, min(n - 1, self.shown + int(value or 1)))
                self.dirty = True
            elif action == "seek":
                if value is None:
                    raise ValueError("seek needs a frame index")
                self.index = max(0, min(n - 1, int(value)))
                self.dirty = True
            elif action == "speed":
                if value is None:
                    raise ValueError("speed needs a value")
                self.speed = min(SPEEDS, key=lambda s: abs(s - float(value)))
            elif action == "loop":
                self.loop = bool(value)
            else:
                raise ValueError(f"unknown action {action!r}")
            self.cond.notify_all()

    def state(self) -> dict:
        with self.cond:
            return {"source": self.source, "epoch": self.epoch, "replay": self.replay_state(),
                    "recording": self.recorder.state(), "live_error": self.live_error,
                    "replay_error": self.replay_error, "sensor": self.scan_source is not None}
