"""What the browser sees: the live sensors or a recording being played back.

Each live sensor's connection always runs (so recording works whatever is on screen) and publishes to its
own Feed while source == "live"; a player thread publishes recording frames, each to the feed of the
sensor that recorded it, while source == "replay". `epoch` increments whenever the published sequence is
not continuous (source switch, seek, step back, loop wrap) so the client can reset its per-beam history.
The current source's sensors are `sensors()`: the live ones, or those of the recording."""
from __future__ import annotations

import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator, Sequence

from ..clock import DeviceClock, scan_time
from ..errors import describe_error
from ..model import Scan
from ..recording import SESSION_FILE, Session, SessionRecorder, open_recording
from ..rig import merge_rig, rig_for, save_json
from .feed import Feed
from .frames import encode, meta_for_scan, scan_meta
from .health import Health, log, supervised
from .player import Player


@dataclass
class LiveSensor:
    """One configured sensor: its scan source and what its live loop and status poll know about it."""
    name: str
    source: Callable[[], Iterator[Scan]]
    ip: str = ""
    label: str = "sensor"                        # prefix of its error messages
    error: str = ""
    status: dict = field(default_factory=dict)   # latest REST device values (see status.py)
    rate: float = 0.0
    clock: DeviceClock = field(default_factory=DeviceClock)
    health: Health | None = None


class Hub:
    def __init__(self, rec_dir: Path, sensors: Sequence[LiveSensor] = (), retry_s: float = 3.0,
                 rig: dict | None = None, rig_path: Path | None = None):
        self.live = list(sensors)
        for s in self.live:
            if len(self.live) > 1:
                s.label = f"sensor {s.name}"
            s.health = Health(f"{s.label} (CoLa)", retry_s)
        self.retry_s = retry_s
        self.rig = rig or {"sensors": []}        # poses of the live sensors (rig.json)
        self.rig_path = rig_path
        self.cond = threading.Condition()        # guards everything below (RLock based)
        self.stop_event = threading.Event()
        self.source = "live"
        self.player = Player()
        self.epoch = 0
        self.last_source: str | None = None
        self.replay_error = ""
        self.replay_health = Health("replay")
        self.feeds: dict[str, Feed] = {}
        self.published: dict[str, float] = {}    # last replay publish time per sensor (for its rate)
        self.recorder = SessionRecorder(rec_dir, rig=lambda: rig_for(self.rig, self.live_names()))
        self.threads: list[threading.Thread] = []

    # --- lifecycle ---
    def start(self):
        loops = [(f"{s.label} stream", lambda s=s: self.live_loop(s)) for s in self.live] + [("player", self.player_loop)]
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

    # --- sensors and feeds ---
    def live_names(self) -> list[str]:
        return [s.name for s in self.live]

    def sensors(self) -> list[str]:
        """The current source's sensors, in rig order (the first is the default for /api/frame)."""
        with self.cond:
            if self.source == "replay" and self.player.rec:
                return list(self.player.rec.sensors)
            return self.live_names() or ["sensor"]

    def feed(self, name: str | None = None) -> Feed:
        """A sensor's feed (the current source's first sensor when `name` is None)."""
        with self.cond:
            name = name or self.sensors()[0]
            if name not in self.feeds:
                self.feeds[name] = Feed()
            return self.feeds[name]

    def live_sensor(self, name: str | None = None) -> LiveSensor | None:
        if name is None:
            return self.live[0] if self.live else None
        return next((s for s in self.live if s.name == name), None)

    # --- publishing ---
    def publish(self, source: str, sensor: str, data: bytes, meta: dict, seq: int):
        with self.cond:
            if source != self.source:
                return
            if source != self.last_source or (source == "replay" and seq != self.player.shown + 1):
                self.epoch += 1
            self.last_source = source
            meta.update(source=source, epoch=self.epoch, sensor=sensor)
            if source == "replay":
                self.player.shown = seq
                meta["replay"] = self.player.state()
            feed = self.feed(sensor)
        feed.publish(data, meta)

    # --- live sensors ---
    def live_loop(self, s: LiveSensor):
        """Connect, stream, and on any failure (sensor off, unplugged, timeout, bad telegram) log one
        short line and reconnect every retry_s seconds."""
        k = 0
        while not self.stop_event.is_set():
            try:
                last = time.time()
                for scan in s.source():
                    if self.stop_event.is_set():
                        return
                    now = time.time()
                    if s.health.error:
                        s.health.ok()
                        s.error = ""
                    ts = scan_time(s.clock, scan, now)
                    upside_down = s.status.get("UpsideDown")
                    self.recorder.write(s.name, scan, ts, upside_down)
                    s.rate = 1.0 / max(now - last, 1e-3)
                    if self.source == "live":
                        meta = meta_for_scan(scan, s.rate, ts)
                        meta["upside_down"] = upside_down
                        self.publish("live", s.name, encode(scan), meta, k)
                    k += 1
                    last = now
                s.error = f"{s.label}: " + s.health.fail("stream ended")
            except Exception as e:
                s.error = f"{s.label}: " + s.health.fail(e)
            self.stop_event.wait(self.retry_s)

    # --- playback ---
    def player_loop(self):
        while not self.stop_event.is_set():
            try:
                self._play_step()
            except Exception as e:
                with self.cond:
                    rec = self.player.rec
                    name = rec.path.name if rec else "recording"
                self.replay_error = self.replay_health.fail(f"{name}: {describe_error(e)}; back to live")
                self.go_live(keep_error=True)
                self.stop_event.wait(0.5)

    def _play_step(self):
        """Show one recording frame (and wait until the next is due)."""
        player = self.player
        with self.cond:
            self.cond.wait_for(lambda: self.stop_event.is_set() or (self.source == "replay" and player.due))
            if self.stop_event.is_set():
                return
            rec, t_start = player.rec, time.time()
            nxt = player.next_frame()
            if nxt is None:                          # nothing complete yet (file still being recorded)
                self.cond.wait(0.5)
                return
            k, delay = nxt
            sensor, ts, data, points, hdr = rec.frame(k)
        now = time.time()
        last = self.published.get(sensor, now - 0.1)
        self.published[sensor] = now
        meta = scan_meta(points, int(hdr["layers"]), int(hdr["beams"]), hdr["start_azimuth_deg"], hdr["step_deg"],
                         1.0 / max(now - last, 1e-3), ts)
        meta["upside_down"] = hdr.get("upside_down")
        self.publish("replay", sensor, data, meta, k)
        deadline = t_start + delay                   # recorded pace, minus decode time
        with self.cond:   # wait for the next frame, but react at once to pause / seek / source change
            while (rem := deadline - time.time()) > 0 and player.playing and not player.dirty \
                    and self.source == "replay" and player.rec is rec and not self.stop_event.is_set():
                self.cond.wait(rem)

    # --- control (called from the API) ---
    def play_file(self, path: Path):
        rec = open_recording(path)
        self.replay_error = ""
        self.replay_health.ok()
        log(f"replaying {Path(path).name}")
        with self.cond:
            self.player.load(rec)
            self.source = "replay"
            self.published.clear()
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
        if not self.live:
            raise ValueError("no sensor connected (offline mode)")
        return self.recorder.start(self.live_names(), path)

    def stop_recording(self):
        self.recorder.stop()

    def delete_recording(self, path: Path):
        """Delete a recording (file or session folder): refused while it is being recorded; played back →
        back to live first."""
        rs = self.recorder.state()
        if rs.get("active") and rs.get("file") == path.name and self.recorder.path.resolve() == path.resolve():
            raise ValueError("stop the recording first")
        playing = self.playing_file()
        if playing and playing.resolve() == path.resolve():
            self.go_live()
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()

    # --- the rig (sensor poses) ---
    def current_rig(self) -> dict:
        """Poses of the current source's sensors: rig.json while live, the session's own while replaying."""
        with self.cond:
            rec = self.player.rec if self.source == "replay" else None
            rig = rec.meta.get("rig", {}) if isinstance(rec, Session) else self.rig
            return rig_for(rig, self.sensors())

    def set_rig(self, update: dict) -> dict:
        """Store calibration results for the current source: rig.json, or the session being replayed."""
        with self.cond:
            rec = self.player.rec if self.source == "replay" else None
            if rec is not None and not isinstance(rec, Session):
                raise ValueError("a single-sensor recording has no rig to store")
            names = set(self.sensors())
            if any(not isinstance(u, dict) or u.get("name") not in names for u in update.get("sensors", [])):
                raise ValueError(f"unknown sensor (the current ones: {', '.join(sorted(names))})")
            if isinstance(rec, Session):
                rec.meta["rig"] = merge_rig(rec.meta.get("rig", {"sensors": []}), update)
                save_json(rec.path / SESSION_FILE, rec.meta)
            else:
                self.rig = merge_rig(self.rig, update)
                if self.rig_path:
                    save_json(self.rig_path, self.rig)
        return self.current_rig()

    # --- state ---
    def live_error(self) -> str:
        return "; ".join(s.error for s in self.live if s.error)

    def status_error(self) -> str:
        """The live sensors' errors, while the live sensors are shown."""
        return self.live_error() if self.source == "live" else ""

    def sensor_info(self) -> list[dict]:
        """The current source's sensors: name, and for live ones their address, error, rate and clock."""
        with self.cond:
            live = self.source == "live"
            names = self.sensors()
        out = []
        for name in names:
            s = self.live_sensor(name) if live else None
            info = {"name": name, "live": s is not None}
            if s:
                info.update(ip=s.ip, error=s.error, rate=round(s.rate, 2), clock=s.clock.state(),
                            device=s.status.get("DeviceType"), upside_down=s.status.get("UpsideDown"))
            out.append(info)
        return out

    def state(self) -> dict:
        with self.cond:
            return {"source": self.source, "epoch": self.epoch, "replay": self.player.state(),
                    "recording": self.recorder.state(), "live_error": self.live_error(),
                    "replay_error": self.replay_error, "sensor": bool(self.live), "sensors": self.sensors()}
