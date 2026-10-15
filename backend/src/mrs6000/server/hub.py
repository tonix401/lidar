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
from ..recording import Recorder, Recording
from .feed import Feed
from .frames import encode, meta_for_scan, scan_meta
from .health import Health, log, supervised
from .player import Player


class Hub:
    def __init__(self, feed: Feed, rec_dir: Path, scan_source: Callable[[], Iterator[Scan]] | None = None,
                 retry_s: float = 3.0):
        self.feed = feed
        self.scan_source = scan_source           # () -> iterator of live scans; None = no sensor
        self.retry_s = retry_s
        self.cond = threading.Condition()        # guards everything below (RLock based)
        self.stop_event = threading.Event()
        self.source = "live"
        self.player = Player()
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
            if source != self.last_source or (source == "replay" and seq != self.player.shown + 1):
                self.epoch += 1
            self.last_source = source
            meta.update(source=source, epoch=self.epoch)
            if source == "replay":
                self.player.shown = seq
                meta["replay"] = self.player.state()
        self.feed.publish(data, meta)

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
                    rec = self.player.rec
                    name = rec.path.name if rec else "recording"
                self.replay_error = self.replay_health.fail(f"{name}: {describe_error(e)}; back to live")
                self.go_live(keep_error=True)
                self.stop_event.wait(0.5)

    def _play_step(self, last: float) -> float:
        """Show one recording frame (and wait until the next is due); returns the publish time."""
        player = self.player
        with self.cond:
            self.cond.wait_for(lambda: self.stop_event.is_set() or (self.source == "replay" and player.due))
            if self.stop_event.is_set():
                return last
            rec, t_start = player.rec, time.time()
            nxt = player.next_frame()
            if nxt is None:                          # nothing complete yet (file still being recorded)
                self.cond.wait(0.5)
                return last
            k, delay = nxt
            ts, data, points = rec.encoded(k)
        now = time.time()
        meta = scan_meta(points, rec.L, rec.B, rec.hdr["start_azimuth_deg"], rec.hdr["step_deg"],
                         1.0 / max(now - last, 1e-3), ts)
        self.publish("replay", data, meta, k)
        deadline = t_start + delay                   # recorded pace, minus decode time
        with self.cond:   # wait for the next frame, but react at once to pause / seek / source change
            while (rem := deadline - time.time()) > 0 and player.playing and not player.dirty \
                    and self.source == "replay" and player.rec is rec and not self.stop_event.is_set():
                self.cond.wait(rem)
        return now

    # --- control (called from the API) ---
    def play_file(self, path: Path):
        rec = Recording(path)
        self.replay_error = ""
        self.replay_health.ok()
        log(f"replaying {Path(path).name}")
        with self.cond:
            self.player.load(rec)
            self.source = "replay"
            self.cond.notify_all()

    def go_live(self, keep_error: bool = False):
        if not keep_error:
            self.replay_error = ""
        with self.cond:
            self.source = "live"
            self.player.unload()
            self.cond.notify_all()

    def playing_file(self) -> Path | None:
        with self.cond:
            return self.player.rec.path if self.player.rec else None

    def control(self, action: str, value=None):
        with self.cond:
            self.player.control(action, value)
            self.cond.notify_all()

    def start_recording(self, path: str | Path | None = None) -> Path:
        if path is None and self.scan_source is None:
            raise ValueError("no sensor connected (offline mode)")
        return self.recorder.start(path)

    def stop_recording(self):
        self.recorder.stop()

    def delete_recording(self, path: Path):
        """Delete a recording file: refused while it is being recorded; played back → back to live first."""
        rs = self.recorder.state()
        if rs.get("active") and rs.get("file") == path.name and self.recorder.path.resolve() == path.resolve():
            raise ValueError("stop the recording first")
        playing = self.playing_file()
        if playing and playing.resolve() == path.resolve():
            self.go_live()
        path.unlink()

    def status_error(self) -> str:
        """The live sensor's error, while the live sensor is shown."""
        return self.live_error if self.source == "live" else ""

    def state(self) -> dict:
        with self.cond:
            return {"source": self.source, "epoch": self.epoch, "replay": self.player.state(),
                    "recording": self.recorder.state(), "live_error": self.live_error,
                    "replay_error": self.replay_error, "sensor": self.scan_source is not None}
