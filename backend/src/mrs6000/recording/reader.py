"""Reading recordings (format: format.py)."""
from __future__ import annotations

import json
import struct
from array import array
from bisect import bisect_right
from compression import zstd
from operator import itemgetter
from pathlib import Path

from ..errors import describe_error
from ..model import Echo, Layer, Scan
from .format import DIST_UNIT_MM, INDEX, INDEX_TAG, SKIP_MAGIC, ZSTD_MAGIC, Frame


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
