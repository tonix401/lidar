"""Recording live scans to .tpc.zstd (format: format.py)."""
from __future__ import annotations

import queue
import threading
import time
from pathlib import Path

from ..errors import describe_error
from ..log import log
from ..model import Scan
from .format import CHUNK_FRAMES, FAST_LEVEL, LEVEL, Frame, frame_values, stream_chunk, stream_header, zstd_entry


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
