"""Recordings (.mrsstream).

One JSON header line {layers, beams, start_azimuth_deg, step_deg, elev[layers*beams], upside_down?},
then per scan: float64 unix time, uint16 raw distance (units of 12.5 mm, 0 = invalid), uint16 rssi —
layer-major, little endian. Fixed frame size, so frame k sits at header_end + k * frame_size.
~88 kB per scan (~53 MB per minute at 10 Hz)."""
from __future__ import annotations

import json
import re
import struct
import threading
import time
from array import array
from pathlib import Path

from ..errors import describe_error
from ..model import Echo, Layer, Scan
from .health import log

NAME_RE = re.compile(r"^[\w.-]+\.mrsstream$")
DIST_UNIT_MM = 12.5


def stream_header(scan: Scan, upside_down: bool | None = None) -> bytes:
    L = scan.layers
    hdr = {"layers": len(L), "beams": L[0].beam_count, "start_azimuth_deg": L[0].start_azimuth_deg,
           "step_deg": L[0].step_deg, "elev": [e for l in L for e in l.elevations_deg()]}
    if upside_down is not None:
        hdr["upside_down"] = upside_down
    return (json.dumps(hdr) + "\n").encode()


def stream_frame(scan: Scan, t: float) -> bytes:
    d = array("H", (min(65535, int(round(x / DIST_UNIT_MM))) for l in scan.layers for x in l.echoes[0].distance_mm))
    r = array("H", (min(65535, max(0, int(v))) for l in scan.layers for v in l.echoes[0].rssi))
    return struct.pack("<d", t) + d.tobytes() + r.tobytes()


class Recording:
    """Random access to a .mrsstream file."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.f = open(self.path, "rb")
        try:
            self.hdr = json.loads(self.f.readline())
            self.L, self.B = int(self.hdr["layers"]), int(self.hdr["beams"])
            if len(self.hdr["elev"]) != self.L * self.B:
                raise ValueError("header elevation table has the wrong size")
        except (ValueError, KeyError, TypeError) as e:
            self.f.close()
            raise ValueError(f"not a .mrsstream recording ({describe_error(e)})") from None
        self.start = self.f.tell()
        self.frame_size = 8 + 4 * self.L * self.B
        self.elev = array("f", self.hdr["elev"]).tobytes()

    @property
    def count(self) -> int:
        """Complete frames (grows while the file is still being recorded)."""
        return max(0, (self.path.stat().st_size - self.start) // self.frame_size)

    def time(self, k: int) -> float:
        self.f.seek(self.start + k * self.frame_size)
        return struct.unpack("<d", self.f.read(8))[0]

    def raw(self, k: int) -> tuple[float, array, array]:
        if not 0 <= k < self.count:
            raise IndexError(f"frame {k} out of range")
        n = self.L * self.B
        self.f.seek(self.start + k * self.frame_size)
        ts = struct.unpack("<d", self.f.read(8))[0]
        d = array("H"); d.frombytes(self.f.read(2 * n))
        r = array("H"); r.frombytes(self.f.read(2 * n))
        return ts, d, r

    def scan(self, k: int) -> tuple[float, Scan]:
        ts, d, r = self.raw(k)
        L, B, hdr = self.L, self.B, self.hdr
        scan = Scan(scan_frequency_hz=10.0)
        for l in range(L):
            sl = slice(l * B, (l + 1) * B)
            scan.layers.append(Layer(
                elevation_deg=hdr["elev"][l * B + B // 2], start_azimuth_deg=hdr["start_azimuth_deg"],
                step_deg=hdr["step_deg"], beam_elevation_deg=hdr["elev"][sl],
                echoes=[Echo([x * DIST_UNIT_MM for x in d[sl]], list(r[sl]))]))
        return ts, scan

    def encoded(self, k: int) -> tuple[float, bytes, int]:
        """Frame k in the /api/frame wire format (as frames.encode()), without building a Scan."""
        ts, d, r = self.raw(k)
        dist = array("f", (x * (DIST_UNIT_MM / 1000) for x in d))
        return ts, dist.tobytes() + array("f", r).tobytes() + self.elev, sum(1 for x in d if x)

    def info(self) -> dict:
        n = self.count
        dur = self.time(n - 1) - self.time(0) if n > 1 else 0.0
        st = self.path.stat()
        return {"name": self.path.name, "bytes": st.st_size, "scans": n, "seconds": round(dur, 2),
                "created": self.time(0) if n else st.st_mtime}

    def close(self):
        self.f.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class Recorder:
    """Writes live scans to a .mrsstream file while active. Disk errors stop the recording (with a
    message in state()), never the caller."""

    def __init__(self, rec_dir: Path):
        self.rec_dir = Path(rec_dir)
        self.lock = threading.Lock()
        self.f = None
        self.path: Path | None = None
        self.scans = 0
        self.t0 = 0.0
        self.upside_down: bool | None = None
        self.error = ""

    @property
    def active(self) -> bool:
        return self.f is not None

    def start(self, path: str | Path | None = None) -> Path:
        with self.lock:
            if self.f:
                return self.path
            if path is None:
                self.rec_dir.mkdir(parents=True, exist_ok=True)
                path = self.rec_dir / time.strftime("rec_%Y%m%d_%H%M%S.mrsstream")
            self.path, self.f, self.scans, self.t0 = Path(path), open(path, "wb"), 0, time.time()
            self.error = ""
            log(f"recording to {self.path}")
            return self.path

    def write(self, scan: Scan, ts: float):
        with self.lock:
            if not self.f:
                return
            try:
                if self.f.tell() == 0:
                    self.f.write(stream_header(scan, self.upside_down))
                self.f.write(stream_frame(scan, ts))
                self.f.flush()
                self.scans += 1
            except Exception as e:                  # e.g. disk full: stop recording, keep streaming
                self.error = f"recording stopped: {describe_error(e)}"
                log(self.error)
                self._close()

    def _close(self):
        try:
            if self.f:
                self.f.close()
                log(f"recording saved: {self.path.name} ({self.scans} scans)")
        except OSError as e:
            log(f"recording: {describe_error(e)}")
        self.f = None

    def stop(self):
        with self.lock:
            self._close()

    def state(self) -> dict:
        with self.lock:
            if not self.f:
                return {"active": False, "error": self.error}
            return {"active": True, "file": self.path.name, "scans": self.scans,
                    "bytes": self.f.tell(), "seconds": round(time.time() - self.t0, 1)}


def list_recordings(rec_dir: Path) -> list[dict]:
    """Newest first; unreadable files are listed with an `error`."""
    out = []
    if not Path(rec_dir).is_dir():
        return out
    for p in sorted(Path(rec_dir).glob("*.mrsstream"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            with Recording(p) as r:
                out.append(r.info())
        except Exception as e:
            out.append({"name": p.name, "bytes": p.stat().st_size, "error": describe_error(e)})
    return out


def recording_path(rec_dir: Path, name: str) -> Path:
    """Resolve a recording name from the API; only plain *.mrsstream names inside rec_dir."""
    if not NAME_RE.match(name or ""):
        raise ValueError("invalid recording name")
    p = Path(rec_dir) / name
    if not p.is_file():
        raise FileNotFoundError(name)
    return p
