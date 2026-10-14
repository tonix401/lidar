"""Recordings: temporal point clouds.

x.tpc: one JSON header line {layers, beams, start_azimuth_deg, step_deg, elev[layers*beams], upside_down?},
then fixed-size scans: float64 unix time, uint16 raw distance (units of 12.5 mm, 0 = invalid), uint16 rssi
— layer-major, little endian. Scan k sits at header_end + k * frame_size. ~88 kB per scan (~53 MB per
minute at 10 Hz).

x.tpc.zstd (what the recorder writes): a standard zstd stream that decompresses to x.tpc (`zstd -d`).
Its zstd frames hold the header line, then chunks of up to CHUNK_FRAMES scans. Each is preceded by an
index entry in a skippable frame (which zstd ignores): b"TPC1", uint32 scans m, uint32 length of the zstd
frame that follows, the m float64 scan times (m = 0 for the header). Chunks are written whole, so readers
index complete chunks only. ~13 kB per scan (~7.5 MB per minute, indoor scene)."""
from __future__ import annotations

import json
import os
import queue
import re
import struct
import threading
import time
from array import array
from bisect import bisect_right
from compression import zstd
from concurrent.futures import ThreadPoolExecutor
from operator import itemgetter
from pathlib import Path

from ..errors import describe_error
from ..model import Echo, Layer, Scan
from .health import log

NAME_RE = re.compile(r"^[\w.-]+\.tpc(\.zstd)?$")
DIST_UNIT_MM = 12.5
CHUNK_FRAMES = 25            # 2.5 s at 10 Hz: what a crash can lose, how far a file being recorded lags
LEVEL = 19                   # ~14 ms per scan on a desktop core, in the writer thread
FAST_LEVEL = 3               # used while the writer falls behind (slow machine)
SKIP_MAGIC = 0x184D2A5E      # zstd skippable frame
ZSTD_MAGIC = 0xFD2FB528      # zstd data frame
INDEX = struct.Struct("<II4sII")   # skippable magic, content size, b"TPC1", scans, zstd frame length
INDEX_TAG = b"TPC1"

Frame = tuple[float, bytes, bytes]   # time, distances, rssi (uint16 bytes)


def stream_header(scan: Scan, upside_down: bool | None = None) -> bytes:
    L = scan.layers
    hdr = {"layers": len(L), "beams": L[0].beam_count, "start_azimuth_deg": L[0].start_azimuth_deg,
           "step_deg": L[0].step_deg, "elev": [e for l in L for e in l.elevations_deg()]}
    if upside_down is not None:
        hdr["upside_down"] = upside_down
    return (json.dumps(hdr) + "\n").encode()


def frame_values(scan: Scan) -> tuple[bytes, bytes]:
    d = array("H", (min(65535, int(round(x / DIST_UNIT_MM))) for l in scan.layers for x in l.echoes[0].distance_mm))
    r = array("H", (min(65535, max(0, int(v))) for l in scan.layers for v in l.echoes[0].rssi))
    return d.tobytes(), r.tobytes()


def stream_frame(scan: Scan, t: float) -> bytes:
    """One .tpc scan."""
    d, r = frame_values(scan)
    return struct.pack("<d", t) + d + r


def zstd_entry(data: bytes, times: list[float] = (), level: int = LEVEL) -> bytes:
    """`data` as one zstd frame, preceded by its index entry."""
    z = zstd.compress(data, level=level)
    return (INDEX.pack(SKIP_MAGIC, 12 + 8 * len(times), INDEX_TAG, len(times), len(z))
            + struct.pack(f"<{len(times)}d", *times) + z)


def stream_chunk(frames: list[Frame], level: int = LEVEL) -> bytes:
    """One .tpc.zstd chunk."""
    return zstd_entry(b"".join(struct.pack("<d", t) + d + r for t, d, r in frames), [f[0] for f in frames], level)


class Recording:
    """Random access to a .tpc or .tpc.zstd file (grows while still being recorded)."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.f = open(self.path, "rb")
        self.times: list[float] = []                        # .tpc.zstd: index of the complete chunks,
        self.chunks: list[tuple[int, int, int, int]] = []   # (first scan, scans, frame offset, frame length)
        self.indexed = 0                                    # file offset after the last indexed entry
        self.cache: dict[int, bytes] = {}                   # decoded chunks (playback reads in order)
        try:
            magic = self.f.read(4)
            self.f.seek(0)
            if magic == struct.pack("<I", ZSTD_MAGIC):
                raise ValueError("plain zstd without the scan index: zstd -d it, or use mrs6000 compress")
            self.compressed = magic == struct.pack("<I", SKIP_MAGIC)
            if self.compressed:
                entry = self._entry(0, self.path.stat().st_size)
                if entry is None or entry[0] != 0:
                    raise ValueError("no header")
                _, off, zlen, _ = entry
                self.f.seek(off)
                self.header = zstd.decompress(self.f.read(zlen))
                self.indexed = off + zlen
            else:
                self.header = self.f.readline()
            self.hdr = json.loads(self.header)
            self.L, self.B = int(self.hdr["layers"]), int(self.hdr["beams"])
            if len(self.hdr["elev"]) != self.L * self.B:
                raise ValueError("header elevation table has the wrong size")
        except (ValueError, KeyError, TypeError, zstd.ZstdError) as e:
            self.f.close()
            raise ValueError(f"not a .tpc recording ({describe_error(e)})") from None
        self.start = len(self.header)
        self.n = self.L * self.B
        self.frame_size = 8 + 4 * self.n
        self.elev = array("f", self.hdr["elev"]).tobytes()
        if self.compressed:
            try:
                self._index()
            except Exception:
                self.f.close()
                raise

    def _entry(self, pos: int, size: int) -> tuple[int, int, int, tuple] | None:
        """Index entry at pos: (scans, frame offset, frame length, times); None if not complete yet."""
        if pos + INDEX.size > size:
            return None
        self.f.seek(pos)
        magic, n, tag, m, zlen = INDEX.unpack(self.f.read(INDEX.size))
        if magic != SKIP_MAGIC or tag != INDEX_TAG or n != 12 + 8 * m:
            raise ValueError(f"corrupt recording (bad index entry at byte {pos})")
        off = pos + INDEX.size + 8 * m
        if off + zlen > size:
            return None
        return m, off, zlen, struct.unpack(f"<{m}d", self.f.read(8 * m))

    def _index(self):
        size = self.path.stat().st_size
        while (entry := self._entry(self.indexed, size)) is not None:
            m, off, zlen, times = entry
            if m == 0:
                raise ValueError(f"corrupt recording (empty chunk at byte {self.indexed})")
            self.chunks.append((len(self.times), m, off, zlen))
            self.times.extend(times)
            self.indexed = off + zlen

    @property
    def count(self) -> int:
        """Complete scans (grows while the file is still being recorded)."""
        if self.compressed:
            self._index()
            return len(self.times)
        return max(0, (self.path.stat().st_size - self.start) // self.frame_size)

    def time(self, k: int) -> float:
        if self.compressed:
            return self.times[k]
        self.f.seek(self.start + k * self.frame_size)
        return struct.unpack("<d", self.f.read(8))[0]

    def _chunk(self, c: int) -> bytes:
        if c not in self.cache:
            _, m, off, zlen = self.chunks[c]
            self.f.seek(off)
            data = zstd.decompress(self.f.read(zlen))
            if len(data) != m * self.frame_size:
                raise ValueError(f"corrupt recording (chunk {c} has the wrong size)")
            if len(self.cache) >= 2:
                del self.cache[next(iter(self.cache))]
            self.cache[c] = data
        return self.cache[c]

    def raw(self, k: int) -> tuple[float, array, array]:
        if not 0 <= k < self.count:
            raise IndexError(f"frame {k} out of range")
        if self.compressed:
            c = bisect_right(self.chunks, k, key=itemgetter(0)) - 1
            j = (k - self.chunks[c][0]) * self.frame_size
            frame = self._chunk(c)[j:j + self.frame_size]
        else:
            self.f.seek(self.start + k * self.frame_size)
            frame = self.f.read(self.frame_size)
        n = self.n
        d, r = array("H"), array("H")
        d.frombytes(frame[8:8 + 2 * n]); r.frombytes(frame[8 + 2 * n:])
        return struct.unpack_from("<d", frame)[0], d, r

    def frames(self, first: int, end: int) -> list[Frame]:
        out = []
        for k in range(first, end):
            ts, d, r = self.raw(k)
            out.append((ts, d.tobytes(), r.tobytes()))
        return out

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
    """Writes live scans to a .tpc.zstd file while active. A writer thread compresses and writes the
    chunks, so compression never holds up the live stream. Disk errors stop the recording (with a
    message in state()), never the caller."""

    def __init__(self, rec_dir: Path, chunk_frames: int = CHUNK_FRAMES):
        self.rec_dir = Path(rec_dir)
        self.chunk_frames = chunk_frames
        self.lock = threading.Lock()
        self.f = None
        self.path: Path | None = None
        self.scans = 0
        self.t0 = 0.0
        self.upside_down: bool | None = None
        self.error = ""                          # also set by the writer thread
        self.bytes = 0                           # written so far
        self.n = 0                               # values per scan, from the first scan
        self.frames: list[Frame] = []            # scans waiting for a full chunk
        self.queue: queue.Queue = queue.Queue()  # header bytes, chunk frame lists, None = done
        self.writer: threading.Thread | None = None

    @property
    def active(self) -> bool:
        return self.f is not None and not self.error

    def start(self, path: str | Path | None = None) -> Path:
        with self.lock:
            if self.f:
                if not self.error:
                    return self.path
                self._close()
            if path is None:
                self.rec_dir.mkdir(parents=True, exist_ok=True)
                path = self.rec_dir / time.strftime("rec_%Y%m%d_%H%M%S.tpc.zstd")
            self.path, self.f, self.scans, self.t0 = Path(path), open(path, "wb"), 0, time.time()
            self.error, self.bytes, self.n, self.frames = "", 0, 0, []
            self.queue = queue.Queue()
            self.writer = threading.Thread(target=self._write_loop, args=(self.f, self.queue), daemon=True,
                                           name="recording writer")
            self.writer.start()
            log(f"recording to {self.path}")
            return self.path

    def write(self, scan: Scan, ts: float):
        with self.lock:
            if not self.f:
                return
            if self.error:                       # the writer failed
                self._close()
                return
            try:
                d, r = frame_values(scan)
                if not self.n:
                    self.n = len(d) // 2
                    self.queue.put(stream_header(scan, self.upside_down))
                elif len(d) != 2 * self.n or len(r) != 2 * self.n:
                    raise ValueError("scan layout changed")
                self.frames.append((ts, d, r))
                self.scans += 1
                if len(self.frames) >= self.chunk_frames:
                    self.queue.put(self.frames)
                    self.frames = []
            except Exception as e:
                self.error = f"recording stopped: {describe_error(e)}"
                log(self.error)
                self._close()

    def _write_loop(self, f, q: queue.Queue):
        failed = False
        while (item := q.get()) is not None:
            if failed:                           # drop the rest after a disk error
                continue
            try:
                if isinstance(item, bytes):
                    data = zstd_entry(item)
                else:
                    data = stream_chunk(item, LEVEL if q.qsize() < 2 else FAST_LEVEL)
                f.write(data)
                f.flush()
                self.bytes += len(data)
            except Exception as e:               # e.g. disk full: stop recording, keep streaming
                failed = True
                self.error = f"recording stopped: {describe_error(e)}"
                log(self.error)

    def _close(self):
        """Write the last partial chunk, wait for the writer and close (lock held)."""
        if not self.f:
            return
        if self.frames:
            self.queue.put(self.frames)
        self.frames = []
        self.queue.put(None)
        self.writer.join()
        try:
            self.f.close()
            if not self.error:
                log(f"recording saved: {self.path.name} ({self.scans} scans, {self.bytes / 1e6:.1f} MB)")
        except OSError as e:
            log(f"recording: {describe_error(e)}")
        self.f = None

    def stop(self):
        with self.lock:
            self._close()

    def state(self) -> dict:
        with self.lock:
            if not self.active:
                return {"active": False, "error": self.error}
            return {"active": True, "file": self.path.name, "scans": self.scans,
                    "bytes": self.bytes, "seconds": round(time.time() - self.t0, 1)}


def convert(src: str | Path, dst: str | Path, compress: bool = True, level: int = LEVEL) -> int:
    """Write a recording as .tpc.zstd (compress) or .tpc; returns the new size. Goes through a temporary
    file, so dst may be src."""
    dst = Path(dst)
    tmp = dst.with_name(dst.name + ".tmp")
    workers = os.cpu_count() or 1
    try:
        with Recording(src) as rec, open(tmp, "wb") as f, ThreadPoolExecutor(workers) as pool:
            n = rec.count
            batches = (rec.frames(k, min(n, k + CHUNK_FRAMES)) for k in range(0, n, CHUNK_FRAMES))
            if compress:                         # zstd releases the GIL: chunks compress in parallel
                f.write(zstd_entry(rec.header, level=level))
                for chunk in pool.map(lambda fr: stream_chunk(fr, level), batches, buffersize=2 * workers):
                    f.write(chunk)
            else:
                f.write(rec.header)
                for frames in batches:
                    f.write(b"".join(struct.pack("<d", ts) + d + r for ts, d, r in frames))
        tmp.replace(dst)
    finally:
        tmp.unlink(missing_ok=True)
    return dst.stat().st_size


def list_recordings(rec_dir: Path) -> list[dict]:
    """Newest first; unreadable files are listed with an `error`."""
    out = []
    if not Path(rec_dir).is_dir():
        return out
    files = [p for p in Path(rec_dir).iterdir() if NAME_RE.match(p.name) and p.is_file()]
    for p in sorted(files, key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            with Recording(p) as r:
                out.append(r.info())
        except Exception as e:
            out.append({"name": p.name, "bytes": p.stat().st_size, "error": describe_error(e)})
    return out


def recording_path(rec_dir: Path, name: str) -> Path:
    """Resolve a recording name from the API; only plain *.tpc / *.tpc.zstd names inside rec_dir."""
    if not NAME_RE.match(name or ""):
        raise ValueError("invalid recording name")
    p = Path(rec_dir) / name
    if not p.is_file():
        raise FileNotFoundError(name)
    return p
