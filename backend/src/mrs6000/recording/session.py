"""Multi-sensor recordings ("sessions"): a folder with one .tpc.zstd per sensor and a session.json

  rec_20261020_120000/
    session.json      {"sensors": [{"name": "a", "file": "a.tpc.zstd"}, ...], "rig": {...}, "created": t,
                       "complete": false until the recording stopped}
    a.tpc.zstd  b.tpc.zstd  ...

The scan times of all files are on one clock (the host's, see clock.py), so a replay merges them into one
timeline. A single sensor still records a plain .tpc.zstd file."""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Callable

from ..errors import describe_error
from ..model import Scan
from ..rig import save_json
from .reader import Recording
from .recorder import Recorder

SESSION_FILE = "session.json"


def is_session(path: Path) -> bool:
    return Path(path).is_dir() and (Path(path) / SESSION_FILE).is_file()


class Session:
    """A session read as one recording: frame k is the k-th scan in time over all sensors. Grows while it
    is being recorded: until session.json says complete, only scans up to the last time every sensor has
    reached are shown, so frames are only ever appended (a sensor's chunk lags up to 2.5 s)."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        try:
            self.meta = json.loads((self.path / SESSION_FILE).read_text())
            self.names = [s["name"] for s in self.meta["sensors"]]
            files = [self.path / s["file"] for s in self.meta["sensors"]]
            if not self.names or any(Path(f).parent != self.path for f in files):
                raise ValueError("bad sensor list")
        except (OSError, ValueError, KeyError, TypeError) as e:
            raise ValueError(f"not a session ({describe_error(e)})") from None
        self.recs: list[Recording] = []
        try:
            for f in files:
                self.recs.append(Recording(f))
        except Exception:
            self.close()
            raise
        self.hdr = self.recs[0].hdr
        self.order: list[tuple[float, int, int]] = []     # (time, sensor index, scan index), in time order
        self.next = [0] * len(self.recs)                   # first scan of each sensor not in `order` yet
        self.complete = bool(self.meta.get("complete"))

    @property
    def sensors(self) -> list[str]:
        return self.names

    @property
    def count(self) -> int:
        self._merge()
        return len(self.order)

    def _merge(self):
        counts = [r.count for r in self.recs]
        if counts == self.next:
            return
        if not self.complete:
            try:
                self.complete = bool(json.loads((self.path / SESSION_FILE).read_text()).get("complete"))
            except (OSError, ValueError):
                pass
        if self.complete:
            cutoff = float("inf")
        elif all(counts):
            cutoff = min(r.time(c - 1) for r, c in zip(self.recs, counts))
        else:
            return
        new = []
        for i, (r, c) in enumerate(zip(self.recs, counts)):
            k = self.next[i]
            while k < c and (t := r.time(k)) <= cutoff:
                new.append((t, i, k))
                k += 1
            self.next[i] = k
        new.sort()
        self.order.extend(new)

    def time(self, k: int) -> float:
        return self.order[k][0]

    def frame(self, k: int) -> tuple[str, float, bytes, int, dict]:
        _, i, j = self.order[k]
        ts, data, points = self.recs[i].encoded(j)
        return self.names[i], ts, data, points, self.recs[i].hdr

    def info(self) -> dict:
        n = self.count
        dur = self.time(n - 1) - self.time(0) if n > 1 else 0.0
        return {"name": self.path.name, "bytes": sum(r.path.stat().st_size for r in self.recs), "scans": n,
                "seconds": round(dur, 2), "created": self.time(0) if n else self.meta.get("created", 0),
                "sensors": self.names}

    def close(self):
        for r in self.recs:
            r.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def open_recording(path: str | Path) -> Recording | Session:
    return Session(path) if Path(path).is_dir() else Recording(path)


class SessionRecorder:
    """Records every live sensor at once: one sensor → a plain .tpc.zstd (as before), several → a session
    folder. `rig` returns the current rig, stored in session.json so a replay is self-contained."""

    def __init__(self, rec_dir: Path, rig: Callable[[], dict] = dict):
        self.rec_dir = Path(rec_dir)
        self.rig = rig
        self.recorders: dict[str, Recorder] = {}
        self.path: Path | None = None            # the file or session folder being recorded
        self.session = False
        self.t0 = 0.0

    @property
    def active(self) -> bool:
        return any(r.active for r in self.recorders.values())

    def start(self, names: list[str], path: str | Path | None = None) -> Path:
        if self.active:
            return self.path
        self.stop()
        if not names:
            raise ValueError("no sensor to record")
        self.rec_dir.mkdir(parents=True, exist_ok=True)
        self.t0 = time.time()
        if len(names) == 1:
            r = Recorder(self.rec_dir)
            self.path, self.session, self.recorders = r.start(path), False, {names[0]: r}
        else:
            folder = Path(path) if path else self.rec_dir / time.strftime("rec_%Y%m%d_%H%M%S")
            folder.mkdir(parents=True, exist_ok=False)
            self.path, self.session = folder, True
            self._write_meta(names, complete=False)
            self.recorders = {}
            for n in names:
                r = Recorder(self.rec_dir)
                r.sensor = n
                r.start(folder / f"{n}.tpc.zstd")
                self.recorders[n] = r
        return self.path

    def _write_meta(self, names: list[str], complete: bool):
        save_json(self.path / SESSION_FILE, {"sensors": [{"name": n, "file": f"{n}.tpc.zstd"} for n in names],
                                             "rig": self.rig(), "created": self.t0, "complete": complete})

    def write(self, name: str, scan: Scan, ts: float, upside_down: bool | None = None):
        r = self.recorders.get(name)
        if r:
            r.upside_down = upside_down
            r.write(scan, ts)

    def stop(self):
        for r in self.recorders.values():
            r.stop()
        if self.session and self.path and (self.path / SESSION_FILE).is_file():
            try:
                self._write_meta(list(self.recorders), complete=True)
            except OSError:
                pass
        self.session = False
        self.recorders = {}

    def state(self) -> dict:
        states = [r.state() for r in self.recorders.values()]
        errors = [s["error"] for s in states if s.get("error")]
        if not any(s["active"] for s in states):
            return {"active": False, "error": errors[0] if errors else ""}
        out = {"active": True, "file": self.path.name, "scans": sum(s.get("scans", 0) for s in states),
               "bytes": sum(s.get("bytes", 0) for s in states), "seconds": round(time.time() - self.t0, 1)}
        if errors:
            out["error"] = errors[0]
        if self.session:
            out["sensors"] = list(self.recorders)
        return out
