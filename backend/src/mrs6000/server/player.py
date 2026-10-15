"""Playback position in a recording: which frame to show next and when, and the transport controls.
No threads and no locking: the Hub calls it with its lock held."""
from __future__ import annotations

from ..recording import Recording

SPEEDS = (0.25, 0.5, 1.0, 2.0, 4.0)
ACTIONS = ("play", "pause", "toggle", "step", "seek", "speed", "loop")


class Player:
    def __init__(self):
        self.rec: Recording | None = None        # recording being played
        self.index = 0                           # next frame to show
        self.shown = -1                          # last frame shown
        self.playing = True
        self.dirty = False                       # show `index` once even while paused
        self.speed = 1.0                         # speed and loop stay when another file is loaded
        self.loop = True

    def load(self, rec: Recording):
        self.unload()
        self.rec, self.index, self.shown, self.playing, self.dirty = rec, 0, -1, True, True

    def unload(self):
        if self.rec:
            try:
                self.rec.close()
            except OSError:
                pass
        self.rec = None

    @property
    def due(self) -> bool:
        """A frame should be shown (playing, or a step/seek while paused)."""
        return self.rec is not None and (self.playing or self.dirty)

    def next_frame(self) -> tuple[int, float] | None:
        """The frame to show now, and the seconds until the following one (recorded pace / speed); advances
        `index`. None while the recording has no complete frame yet."""
        rec = self.rec
        n = rec.count
        self.dirty = False
        if n == 0:
            return None
        k = min(self.index, n - 1)
        delay, nxt = 0.0, k + 1                  # index always points at the next frame
        if nxt >= n:
            if self.loop and self.playing:
                nxt = 0
            else:
                nxt, self.playing = k, False
        if self.playing:
            delay = (min(0.5, max(0.0, rec.time(nxt) - rec.time(k))) if nxt == k + 1 else 0.1) / self.speed
        self.index = nxt
        return k, delay

    def control(self, action: str, value=None):
        if not self.rec:
            raise ValueError("not replaying")
        n = self.rec.count
        if action == "play":
            if not self.loop and self.shown >= n - 1:
                self.index = 0
            self.playing = True
        elif action == "pause":
            self.playing = False                 # index already points at the next frame
        elif action == "toggle":
            self.control("pause" if self.playing else "play")
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

    def state(self) -> dict:
        if not self.rec:
            return {}
        rec, n = self.rec, self.rec.count
        t0 = rec.time(0) if n else 0.0
        cur = max(0, min(self.shown, n - 1))
        return {"file": rec.path.name, "index": cur, "count": n,
                "t": round(rec.time(cur) - t0, 2) if n else 0.0,
                "duration": round(rec.time(n - 1) - t0, 2) if n > 1 else 0.0,
                "playing": self.playing, "speed": self.speed, "loop": self.loop,
                "upside_down": rec.hdr.get("upside_down")}
